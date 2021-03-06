
# Node.js Async Context Definitions

This is an effort to formalize & visualize "asynchronous context" in Node.js applications.

The content here is a "simple summary" of more in-depth work, namely:

1. A [DLS 2017 paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/08/NodeAsyncContext.pdf) that formally 
defines semantics of async execution in JavaScript
2.  A ["translation"](./Async-Context-Definitions.md) of the above concepts, without the academic assumptions & formalisms. (*WIP*)

This page is a companion to the above.  The intention is to easily bring an
understanding of the asynchronous execution model formally defined above to a wide audience of Node.js 
and Javascript developers.

## Why do we care?

Javascript is a single-threaded language, which simplifies many things.  To prevent blocking IO, 
operations are pushed onto the background and associated with callback functions written in Javascript.
When IO operations complete, the callback is pushed onto a queue for execution by Node's "event loop". 
This is explained in more detail [here](https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/). 

While this model has many benefits, one of the key challenges is maintaining "context" when
asynchronous callbacks are invoked.  The papers above describe "asynchronous context" in a much more 
rigorous way, but for our purposes, we'll think of "asynchronous context" as the ability to answer, at any given point in program
execution, "what was the path of asynchronous functions that got me here".

## Terminology
During program execution, there are four different types of events that let us track async context:

1.  `executeBegin` - indicates the beginning of execution of an asynchronous function.
2.  `link` - indicates a callback was registered for later asynchronous execution. 
3.  `cause` - indicates a previously linked callback was "resolved" and is now enabled for execution. 
4.  `executeEnd` - indicates the end of execution of an asynchronous function.

For example, consider the code below:

```javascript
console.log('starting');
Promise p = new Promise((reject, resolve) => {
    setTimeout(function f1() {
        console.log('resolving promise');
        resolve(true);
    }, 100);
}).then(function f2() {
  console.log('in then');
}
```

Given our model, this would produce the following event stream:

```json
{"event": "executeBegin", "executeID": 0 } // main program body is starting
// starting
{"event": "link", "executeID":0, "linkID": 1} // indicates f1() was "linked" in the call to "setTimeout()"
{"event": "cause", "executeID":0, "linkID": 1, "causeID": 2}  // indicates f1() is "resolved" and queued for execution (in the timeout queue)
{"event": "link", "executeID":0, "linkID": 3} // indicates f2() was "linked" in the call to "then()"
{"event": "executeEnd", "executeID": 0 } // main program body is ending

{"event": "executeBegin", "executeID": 4, "causeID":2 } // callback f1() is now starting
// resolving promise
{"event": "cause", "executeID":4, "linkID": 3, "causeID": 5} // promise p is now resolved, allowing the "then(function f2()..." to proceed
{"event": "executeEnd", "executeID": 4 } // callback f1() is ending

{"event": "executeBegin", "executeID": 6, "causeID":5 } // callback f2() is now starting
// resolving promise
{"event": "executeEnd", "executeID": 6 } // callback f1() is ending
```

Note that often the callback is both linked and caused at the same point,
like the `f1` argument to `setTimeout` in the above example. With
promises though, the link and cause can be at separate points: in the
previous example, `f2` is linked (i.e. "registered") in the `then` but
caused (i.e. "enabled for execution") inside `f1`.
We can see that event ID's are ordered where in any context,
`link` < `cause` < `beginExecute` < `endExecute`.


## Events Produce the Async Call Graph
The events above allow us to produce a Directed Acyclic Graph ([DAG](https://en.wikipedia.org/wiki/Directed_acyclic_graph))
that we call the "Async Call Graph".  Specifically, the `executeBegin`, `cause` and `link` events correspond to node & edge
creation in the graph.

Such graph can be used for example by a debugger to visualize the current calling context, or to 
step back in time; or by performance tools to attribute resource usage to the correct asynchronous contexts.

## Examples & Visualizations
This all much easier understand when the actual graph is displayed --  we have a list of examples along with step-through visualizations:

 - [simplePromise](./examples/simplePromise/slideShow/async-context.html) - Shows a simple promise example's execution.
 - [simpleExpress](./examples/simpleExpress/slideShow/async-context.html) - Shows a simple express app's execution.
 - [expressMiddleware](./examples/expressMiddleware/slideShow/async-context.html) - Shows express app with middleware being used.
 - [setInterval](./examples/setInterval/slideShow/async-context.html) - Illustrates a call to setInterval.
 - [lazilyInitializedPromise](./examples/lazilyInitializedPromise/slideShow/async-context.html) - Illustrates an express app with a promise that is created & resolved in one request's context, and "then'd" in other requests' context.
 - [markdown-example-1](./examples/markdown-example-1/slideShow/async-context.html) - Shows example 1 from the Async Context Definitions [document](./Async-Context-Definitions.md)
 - [markdown-example-2](./examples/markdown-example-2/slideShow/async-context.html) - Shows example 2 from the  Async Context Definitions[document](./Async-Context-Definitions.md)
 
