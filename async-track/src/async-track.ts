'use strict';

/*tslint:disable:no-var-requires */
const proxiedModule = require('module');
const instrumentConfig = require('./config/instrument-config');
/*tslint:enable:no-var-requires */

import { IContinuation, link, cause } from './continuation';

const originalRequire = proxiedModule.prototype.require;
const cbConfig = instrumentConfig.cbconfig;

export interface IAsyncTrack {
    addHandler(h: IAsyncTrackEvents);
}

// private instance
let instance: IAsyncTrack;

interface IConfigEntry {
    __returnVal__;
    __new__;
    __clearCallback__;
    __parameter__;
    callbackArgIdx;
}

export interface IAsyncTrackWrapperFunction {
    __asyncTrack_original__;
}

export interface IAsyncTrackEvents {
    onError(msg: string);
    onWarning(msg: string);
}

export function getAsyncTrack(): IAsyncTrack {
    if (!instance) {
        instance = new AsyncTrack();
    }
    return instance;
}

// non-exported implementation
class AsyncTrack implements IAsyncTrack {

    private currentAsyncNamePath: string[] = undefined;
    private handlers: IAsyncTrackEvents[] = [];

    public constructor() {
        if (!originalRequire.__asyncTrack_original__) {
            this.asyncTrackInit();
        }
        else {
            throw new Error('AsyncTrack instance initialized more than once!');
        }
    }

    public addHandler(h: IAsyncTrackEvents) {
        this.handlers.push(h);
    }

    private raiseWarning(msg: string) {
        this.handlers.forEach((h) => {
            if (h && h.onWarning) {
                h.onWarning(msg);
            }
        });
    }

    private raiseError(msg: string) {
        this.handlers.forEach((h) => {
            if (h && h.onError) {
                h.onError(msg);
            }
        });
    }

    private fatalError(msg) {
        this.raiseError(msg);

        // exit process in a timeout so we give chance for any telemetry to flush
        setTimeout(() => {
            process.exit(1);
        }, 1000);
    }

    private stamp(originalFunction, wrapperFunction, namePath: string[]) {
        Object.assign(wrapperFunction, originalFunction);
        if (originalFunction.__asyncTrack_original__) {
            const name = namePath.join('.');
            this.raiseWarning(`originalFunction already has __asyncTrack_original__ for function ${name}`);
        }

        if (wrapperFunction.__asyncTrack_original__) {
            const name = namePath.join('.');
            this.raiseWarning(`wrapperFunction already has __asyncTrack_original__for function ${name}`);
        }

        wrapperFunction.__asyncTrack_original__ = originalFunction;
    }

    private asyncTrackInit() {
        const self = this;
        function asyncTrackRequire(moduleName) {

            let loadedModule = originalRequire.apply(this, arguments);

            // some top level require(name) returns a
            // function that needs to be instrumented
            if (cbConfig[moduleName] && cbConfig.hasOwnProperty(moduleName)) {

                // some top level require(name) returns a
                // function that needs to be instrumented
                if (cbConfig[moduleName].__returnVal__) {
                    const tmpPkg = {};
                    const tmpConfig = {};
                    tmpPkg[moduleName] = loadedModule;
                    tmpConfig[moduleName] = cbConfig[moduleName];
                    self.instrument(tmpPkg, tmpConfig, []);
                    loadedModule = tmpPkg[moduleName];
                }
                // the general case
                else {
                    self.instrument(loadedModule, cbConfig[moduleName], [moduleName]);
                }
            }
            else if (moduleName === 'bluebird') {
                if (loadedModule.setScheduler && !loadedModule.setScheduler.__asyncTrack_original__ && typeof loadedModule.setScheduler === 'function') {
                    const originalScheduler = loadedModule.setScheduler(function (fn) {
                        if (fn && typeof fn === 'function') {
                            const c: IContinuation = link(fn);

                            // TODO:  where do we raise cause event for bluebird????
                            cause(c);

                            arguments[0] = c;
                        }
                        originalScheduler.apply(this, arguments);
                    });
                }
            }
            else if (moduleName === 'redis') {
                const oldSend = loadedModule.RedisClient.prototype.internal_send_command;
                loadedModule.RedisClient.prototype.internal_send_command = function (command, ...rest) {
                    if (command && command.callback) {
                        let callback = command.callback;
                        const c: IContinuation = link(callback);
                        cause(c);
                        command.callback = c;
                    }
                    return oldSend.call(this, command, ...rest);
                };
            }

            return loadedModule;
        }

        proxiedModule.prototype.require = asyncTrackRequire;
        Object.assign(proxiedModule.prototype.require, originalRequire);
        this.stamp(originalRequire, proxiedModule.prototype.require, ['module', 'prototype', 'require']);

        // load/instrument common modules that we want to do up-front
        this.instrumentCommon();

    }

    private instrumentCommon() {
        // instrument top level APIs that have a callback
        this.instrument(global, cbConfig.__builtIn__, ['global']);

        // process is the global process var.  We update it here. ;)
        process = require('process');

        //
        // TODO:
        //
        // Some internal modules need to be loaded explicitly for the proxying to take effect.
        // Figure out why this is.  For some reason, the require override doesn't get
        // hit for these methods.
        //
        require('net');
        require('_http_outgoing');
        require('_http_client');

        this.instrumentPromise(global.Promise);
        this.instrumentEventEmitter();
    }

    private instrumentEventEmitter() {
        const eventEmitter = proxiedModule.prototype.require('events');

        eventEmitter.prototype.addListener = eventEmitter.prototype.on;

        // removeListener needs to have a custom override since the registered event listener
        // is the proxy method, but the method passed to removeListener is the original method.
        // logic below will find the wrapper associated with the passed in method, and remove
        // and correctly remove it's proxy.
        const save = eventEmitter.prototype.removeListener;
        eventEmitter.prototype.removeListener = function asyncTrackRemoveListener(eventName, listener) {

            // If the same function is registered more than once, then removeListener() will remove the first one.
            // we replicate that logic here.
            if (typeof listener === 'function') {
                const listeners = this.listeners(eventName);
                if (listeners) {
                    for (let i = 0; i < listeners.length; i++) {
                        const c: IContinuation = listeners[i];
                        if (c.isContinuation && c.originalFunction && c.originalFunction === listener) {
                            arguments[1] = listeners[i];
                            break;
                        }
                    }
                }
                return save.apply(this, arguments);

            };
        };

    }

    /**
     * instrument the callback registration functions according
     * to a configuration data structure
     *
     * @param {Object} pkg an object or function that contains the callback registration functions
     * @param {Object} config the configuration data structure
     * @param {Array} namePath a list that represents the path that has been went through
     * to reach the current registration function (for debugging insepction)
     */
    private instrument(pkg, config, namePath) {

        if ((!pkg) || (!config)) {
            return pkg;
        }

        namePath = namePath ? namePath : [];
        const queue = [{ pkg: pkg, config: config, path: namePath }];
        while (queue.length > 0) {
            const entity = queue.shift();
            pkg = entity.pkg;
            config = entity.config;
            const curPath = entity.path;
            for (let prop in config) {
                if (config.hasOwnProperty(prop)) {
                    if (prop !== '__returnVal__' && prop !== '__configType__' &&
                        prop !== '__parameter__' && prop !== '__new__') {

                        const newPath = curPath.slice(0).concat(prop);

                        if (config[prop].__configType__ === 'package') {
                            if (!(pkg[prop])) {
                                continue;
                            }
                            queue.push({
                                pkg: pkg[prop],
                                config: config[prop],
                                path: newPath
                            });
                        }
                        else if (config[prop].__configType__ === 'cb_type') {
                            this.wrapSetter(pkg, prop, newPath);
                        }
                        else if (!pkg[prop]) {
                            continue;
                        }
                        else {
                            const instrumentedValue = this.instruCbReg(config, prop, pkg[prop], newPath);
                            const propDescriptor = Object.getOwnPropertyDescriptor(pkg, prop);

                            // instrument the method in the pkg
                            if (propDescriptor && propDescriptor.writable) {
                                pkg[prop] = instrumentedValue;
                            } else {
                                Object.defineProperty(pkg, prop, {
                                    ...propDescriptor,
                                    writable: true,
                                    value: instrumentedValue
                                });
                            }

                            // function-package is a function that
                            // 1) has callback registration functions as properties; and
                            // 2) returns an object that has callback registration
                            // functions as properties
                            if (config[prop].__configType__ === 'function-package') {
                                queue.push({
                                    pkg: pkg[prop],
                                    config: config[prop],
                                    path: newPath
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * This function wraps the callback function.
     *
     * @param {function} callback the original callback function that needs to be wrapped
     * @param {Object} instrumentCBConfig a configuration data struture telling any
     * preference for instrumenting this callback
     * @returns the wrapped callback
     */
    //private wrapCallback(callback, instrumentCBConfig, asyncId, asyncState, namepath: string[]) :IContinuation {
    private wrapCallback(callback, raiseCause: boolean): IContinuation {
        // tslint:disable-next-line:no-null-keyword
        if (callback === undefined || callback === null) {
            // if undefined or null, then we should just skip any attempts at instrumentation
            // if 0 or false, we'll fail fast on the next line, as that indicates potentially
            // something wrong.
            return;
        }

        if ((typeof callback) !== 'function') {
            this.raiseError(`callback ${callback} is not of type function.  Actual type is ${typeof callback}.`);
        }

        const self = this;
        const c: IContinuation = link(callback);
        if (raiseCause) {
            cause(c);
        }
        return c;
    }

    // TODO:  need to test this codepath.
    private wrapSetter(pkg, prop, namePath) {
        const self = this;

        if (typeof pkg[prop] === 'function') {
            const c: IContinuation = link(pkg[prop]);
            cause(c);
            pkg[prop] = c;
        }

        pkg['__asyncTrack_wrapped_' + prop + '__'] = pkg[prop];

        Object.defineProperty(pkg, prop, {
            set: function setOverride(func) {
                if (typeof func === 'function') {
                    // TODO:  is this correct???
                    this['__asyncTrack_wrapped_' + prop + '__'] = self.wrapCallback(func, true);
                }
                else {
                    this['__asyncTrack_wrapped_' + prop + '__'] = func;
                }
            },
            get: function getOverride() {
                // TODO:  is this correct????
                return this['__asyncTrack_wrapped_' + prop + '__'];
            }
        });
    }

    /**
     * instrument the callback registration
     *
     * @param {Object} config the instrumentation configuration data structure
     * that corresponds to this registration function
     * @param {string} prop the registration function's property name in its parent package
     * @param {function} origFunc the callback registration function that needs to be instrumented
     * @param {Object} namePath a sequence of package/function names to reach
     * this registration function from the top level scope
     * @returns the instrumented callback registration function
     */
    private instruCbReg(config: IConfigEntry[], prop, origFunc, namePath) {
        if (!origFunc) {
            return origFunc;
        }

        let wrapper;

        if (origFunc.__asyncTrack_original__) {
            // this is a wrapper function, return itself
            // TODO: investigate why it is rewrapped
            origFunc = origFunc.__asyncTrack_original__;
        }

        const self = this;

        if (config[prop].__returnVal__ && config[prop].callbackArgIdx && !(config[prop].__new__)) {
            // instrument function whose has a callback and its return
            // value also contains functions that can have callback
            wrapper = function wrapperCallbackInParameterListAndReturn() {

                self.wrapCallbackInParameterList(config[prop].callbackArgIdx,
                    arguments, true /* fireCauseAtLinkTime*/, namePath);

                const ret = origFunc.apply(this, arguments);

                self.instrument(ret, config[prop].__returnVal__, namePath);
                return ret;
            };

        } else if (config[prop].__returnVal__ && !(config[prop].__new__)) {
            // instrument function whose return value
            // contains functions that can have callback

            wrapper = function wrapReturn() {

                // TODO:  do we need to raiseAsyncTransition() here?  don't think so...
                //const asyncState = raiseAsyncTransition();

                const ret = origFunc.apply(this, arguments);
                self.instrument(ret, config[prop].__returnVal__, namePath);
                return ret;
            };

        } else if (config[prop].__returnVal__ && config[prop].__new__) {
            // instrument constructor whose return value
            // contains functions that can have callback
            wrapper = function wrapReturnFromConstructor() {
                const args = Array.prototype.slice.call(arguments, 0);
                /* tslint:disable:no-null-keyword */
                args.unshift(null);
                /* tslint:enable:no-null-keyword */
                const ctor = (Function.prototype.bind.apply(origFunc, args));

                const ret = new ctor();
                self.instrument(ret, config[prop].__returnVal__, namePath);
                return ret;
            };

        } else if (config[prop].__clearCallback__) {
            // instrument function that has a callback

            //
            // don't think this is necessary
            //
            // wrapper = function wrapClearCallback() {
            //     var ret = origFunc.apply(this, arguments);
            //     return ret;
            // }
        } else {
            wrapper = this.wrapTransition(origFunc, config[prop].callbackArgIdx, true /*fireCauseAtLinkTime*/, namePath);
        }

        if (wrapper) {
            this.stamp(origFunc, wrapper, namePath);
        }
        else {
            wrapper = origFunc;
        }

        return wrapper;
    }

    private wrapTransition(originalFunction, callbackArgIndex, fireCauseAtLinkTime: boolean, namePath) {
        const self = this;
        const wrapped = function wrappedTransition() {
            // const asyncId = self.getNextAsyncId();
            // const asyncState = self.raiseAsyncTransition(self.currentAsyncId, asyncId);
            self.wrapCallbackInParameterList(callbackArgIndex,
                arguments, fireCauseAtLinkTime, namePath);
            const ret = originalFunction.apply(this, arguments);
            return ret;
        };

        return wrapped;
    }

    /**
     * wrap the callback function in the parameter list
     *
     * @param {function} instrFunc the current callback register wrapper
     * @param {Object} startIdxList an array that contains the the earliest index
     * or a list of possible indices where the callback is in the parameter list
     * @param {Object} args the parameter list of the callback function
     * @param {Object} paramConfig the configuration for wrapping the parameter
     * list of the callback to be wrapped
     * @param {string} location the callback register's location
     * @param {Object} passInfo the object that will be passed from register to the callback
     */
    private wrapCallbackInParameterList(startIdxList, args, fireCauseAtLinkTime: boolean, namePath) {
        let callbackParIdx;
        if (startIdxList.length === 1) {
            callbackParIdx = startIdxList[0];
            for (let i = 0; i < 4; i++) { // search backwards 4 times
                if ((typeof (args[callbackParIdx])) === 'function') {
                    this.wrapCallbackInParameter(callbackParIdx, args, fireCauseAtLinkTime, namePath);
                    break;
                }
                else {
                    callbackParIdx++;

                }
            }
        } else {
            for (callbackParIdx of startIdxList) {
                if ((typeof (args[callbackParIdx])) === 'function') {
                    this.wrapCallbackInParameter(callbackParIdx, args, fireCauseAtLinkTime, namePath);
                    break;
                }
            }
        }
    }

    private wrapCallbackInParameter(callbackParIdx, args, fireCauseAtLinkTime: boolean, namePath) {
        let callback = args[callbackParIdx];

        this.assert(typeof callback === 'function');

        const wrappedCallback = this.wrapCallback(callback, fireCauseAtLinkTime);
        if (wrappedCallback) {
            args[callbackParIdx] = wrappedCallback;
        }
    }

    private createOnFullfilledWrapper(originalThen) {
        const thenNamePath = ['global', 'promise', 'prototype', 'then'];

        const self = this;
        function wrapOnFullfilled(onFulfilled, onRejected) {

            if (typeof onFulfilled === 'function') {
                // TODO:  need to figure out where to hook cause event for promises!!
                const fireCauseAtLinkTime = true;
                self.wrapCallbackInParameter(0, arguments, fireCauseAtLinkTime, thenNamePath);
            }
            if (typeof onRejected === 'function') {
                // TODO:  need to figure out where to hook cause event for promises!!
                const fireCauseAtLinkTime = true;
                self.wrapCallbackInParameter(1, arguments, fireCauseAtLinkTime, thenNamePath);
            }

            // other libraries may proxy promises, so we want to be sure that our proxies are always hooked up.
            const ret = originalThen.apply(this, arguments);
            if (!ret.then.__asyncTrack_original__) {
                ret.then = self.createOnFullfilledWrapper(ret.then);
            }
            if (!ret.catch.__asyncTrack_original__) {
                ret.catch = self.createOnRejectedWrapper(ret.catch);
            }
            return ret;
        }

        self.stamp(originalThen, wrapOnFullfilled, thenNamePath);

        return wrapOnFullfilled;
    }

    private createOnRejectedWrapper(originalCatch) {
        const catchNamePath = ['global', 'promise', 'prototype', 'catch'];

        const self = this;

        function wrapOnRejected(...args) {
            // const asyncId = self.getNextAsyncId();
            // const asyncState = self.raiseAsyncTransition(self.currentAsyncId, asyncId);

            // bluebird API allows for "filtered catches", where the first n -1 arguments are constructors
            // or filter functions, and the last argument is the catch handler.  Account for that here.
            let callbackIndex = 0;
            if (args.length > 1 && typeof args[args.length - 1] === 'function') {
                callbackIndex = args.length - 1;
            }

            if (typeof args[callbackIndex] === 'function') {
                // TODO:  need to figure out where to hook cause event for promises!!
                const fireCauseAtLinkTime = true;
                self.wrapCallbackInParameter(callbackIndex, arguments, fireCauseAtLinkTime, catchNamePath);
            }
            const ret = originalCatch.apply(this, arguments);

            // other libraries may proxy promises, so we want to be sure that our proxies are always hooked up.
            if (!ret.then.__asyncTrack_original__) {
                ret.then = self.createOnFullfilledWrapper(ret.then);
            }
            if (!ret.catch.__asyncTrack_original__) {
                ret.catch = self.createOnRejectedWrapper(ret.catch);
            }

            return ret;
        }

        self.stamp(originalCatch, wrapOnRejected, catchNamePath);

        return wrapOnRejected;
    }

    /**
     * instrumentation of the Promise function requires special handling
     */
    private instrumentPromise(promiseObj) {
        const promiseThen = promiseObj.prototype.then;
        const promiseCatch = promiseObj.prototype.catch;

        if (!promiseThen.__asyncTrack_original__) {
            promiseObj.prototype.then = this.createOnFullfilledWrapper(promiseThen);
        }
        if (!promiseCatch.__asyncTrack_original__) {
            promiseObj.prototype.catch = this.createOnRejectedWrapper(promiseCatch);
        }
    }

    private assert(condition: boolean, msg?: string) {
        msg = msg || 'Assertion Failed!';
        if (!condition) {
            this.fatalError(msg);
        }
    }
}
