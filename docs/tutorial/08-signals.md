# Chapter 3.2: Signals - Bridging the Outside World

Remember the `firstSuccess` combinator from [Chapter 05](./05-combinators.md)? We had a polling problem:

```typescript
// The ugly solution - polling a variable
while (!succeeded && failureCount < total) {
  yield* sleep(10);  // Checking a variable in a loop... gross.
}
```

And we solved it elegantly with something called `createSignal()`:

```typescript
// The elegant solution - no polling!
const success = createSignal<T, never>();
// ...
success.send(value);  // No yield*! Just a plain function call
// ...
for (const result of yield* each(success)) {
  return result;
}
```

But we never explained *why* this worked. Now let's understand Signals properly.

---

## The Problem: Callbacks Can't Yield

In the last chapter, we saw that `channel.send()` is an operation - you need `yield*` to call it. But what about code that runs outside of generators?

- DOM event handlers
- Node.js EventEmitter callbacks  
- setTimeout/setInterval callbacks
- Promise `.then()` callbacks
- Spawned tasks communicating back to their parent

This doesn't work:

```typescript
// broken-callback.ts
import { main, createChannel, each } from 'effection';

await main(function*() {
  const channel = createChannel<MouseEvent, void>();
  
  // ERROR: can't use yield* in a callback!
  document.addEventListener('click', (event) => {
    yield* channel.send(event);  // SyntaxError!
  });
});
```

You can only use `yield*` inside a generator function. Callbacks are regular functions.

---

## Signals: Plain Functions That Bridge Worlds

A **Signal** is like a Channel, but its `send()` method is a regular function, not an operation:

```typescript
// signal-basics.ts
import type { Signal } from 'effection';
import { main, createSignal, each } from 'effection';

await main(function*() {
  // Create a signal
  const clicks: Signal<string, void> = createSignal<string, void>();
  
  // clicks.send is a REGULAR FUNCTION - can be used anywhere!
  setTimeout(() => clicks.send('click 1'), 100);
  setTimeout(() => clicks.send('click 2'), 200);
  setTimeout(() => clicks.send('click 3'), 300);
  setTimeout(() => clicks.close(), 400);
  
  // Consume as a stream (same as channel)
  for (const click of yield* each(clicks)) {
    console.log('Received:', click);
    yield* each.next();
  }
  
  console.log('Done');
});
```

Output:
```
Received: click 1
Received: click 2
Received: click 3
Done
```

**This is the key insight**: `signal.send()` doesn't need `yield*`. It's a plain JavaScript function that can be called from anywhere - callbacks, event handlers, spawned tasks, anywhere.

---

## Why firstSuccess Worked

Now we can understand why the Chapter 05 solution worked:

```typescript
function* firstSuccess<T>(operations: (() => Operation<T>)[]): Operation<T> {
  const success = createSignal<T, never>();

  return yield* scoped(function* () {
    for (const op of operations) {
      yield* spawn(function* () {
        try {
          const value = yield* op();
          success.send(value);  // <-- Called from inside a spawned task!
        } catch {
          // Ignore failures
        }
      });
    }

    for (const result of yield* each(success)) {
      return result;
    }

    throw new Error('All operations failed');
  });
}
```

The spawned tasks can call `success.send(value)` without `yield*` because it's a Signal, not a Channel. This lets the child tasks communicate back to the parent without blocking.

---

## Signal vs Channel

| Feature | Channel | Signal |
|---------|---------|--------|
| `send()` returns | `Operation<void>` | `void` |
| Can call in callbacks | No | Yes |
| Use inside operations | `yield* channel.send()` | `signal.send()` |
| Streaming consumption | Same | Same |

**Rule of thumb**:
- Both producer and consumer are Effection operations → **Channel**
- Producer is a callback or external code → **Signal**

---

## Practical Example: DOM Events

In a browser context:

```typescript
// dom-events.ts (browser)
import type { Operation, Signal } from 'effection';
import { main, createSignal, each, ensure } from 'effection';

function* trackClicks(button: HTMLButtonElement): Operation<void> {
  const clicks: Signal<MouseEvent, void> = createSignal<MouseEvent, void>();
  
  // Attach the signal's send function directly as the event handler!
  button.addEventListener('click', clicks.send);
  
  // Clean up when operation ends
  yield* ensure(() => {
    button.removeEventListener('click', clicks.send);
    clicks.close();
  });
  
  // Process clicks
  for (const event of yield* each(clicks)) {
    console.log('Clicked at:', event.clientX, event.clientY);
    yield* each.next();
  }
}

// Usage:
// await main(function*() {
//   const button = document.querySelector('button')!;
//   yield* trackClicks(button);
// });
```

---

## Practical Example: Node.js EventEmitter

```typescript
// emitter-events.ts
import type { Operation, Signal } from 'effection';
import { main, createSignal, spawn, sleep, each, ensure } from 'effection';
import { EventEmitter } from 'events';

interface DataEvent {
  id: number;
  value: string;
}

function* streamEvents(emitter: EventEmitter): Operation<void> {
  const events: Signal<DataEvent, void> = createSignal<DataEvent, void>();
  const errors: Signal<Error, void> = createSignal<Error, void>();
  
  // Attach handlers (regular functions)
  const onData = (data: DataEvent) => events.send(data);
  const onError = (err: Error) => errors.send(err);
  
  emitter.on('data', onData);
  emitter.on('error', onError);
  
  yield* ensure(() => {
    emitter.off('data', onData);
    emitter.off('error', onError);
    events.close();
    errors.close();
  });
  
  // Process events
  for (const event of yield* each(events)) {
    console.log('Data event:', event);
    yield* each.next();
  }
}

// Demo
await main(function*() {
  const emitter = new EventEmitter();
  
  // Start consuming events
  yield* spawn(() => streamEvents(emitter));
  
  yield* sleep(10);
  
  // Emit some events
  emitter.emit('data', { id: 1, value: 'first' });
  emitter.emit('data', { id: 2, value: 'second' });
  emitter.emit('data', { id: 3, value: 'third' });
  
  yield* sleep(100);
});
```

---

## Creating Reusable Stream Factories

Combine signals with resources to create reusable stream factories:

```typescript
// click-stream.ts
import type { Operation, Stream, Subscription, Signal } from 'effection';
import { main, resource, createSignal, spawn, sleep, each, ensure } from 'effection';
import { EventEmitter } from 'events';

// A stream factory for any EventEmitter event
function eventsFrom<T>(
  emitter: EventEmitter,
  eventName: string
): Stream<T, void> {
  return resource<Subscription<T, void>>(function*(provide) {
    const signal: Signal<T, void> = createSignal<T, void>();
    
    const handler = (value: T) => signal.send(value);
    emitter.on(eventName, handler);
    
    try {
      // Provide the subscription (the stream interface)
      const subscription: Subscription<T, void> = yield* signal;
      yield* provide(subscription);
    } finally {
      emitter.off(eventName, handler);
      signal.close();
    }
  });
}

// Usage
await main(function*() {
  const emitter = new EventEmitter();
  
  // Create multiple independent subscriptions to the same events
  yield* spawn(function*(): Operation<void> {
    for (const data of yield* each(eventsFrom<string>(emitter, 'message'))) {
      console.log('Subscriber A:', data);
      yield* each.next();
    }
  });
  
  yield* spawn(function*(): Operation<void> {
    for (const data of yield* each(eventsFrom<string>(emitter, 'message'))) {
      console.log('Subscriber B:', data);
      yield* each.next();
    }
  });
  
  yield* sleep(10);
  
  emitter.emit('message', 'Hello');
  emitter.emit('message', 'World');
  
  yield* sleep(100);
});
```

---

## The Built-in `on()` Function

Effection provides a built-in helper for EventTarget (DOM) events:

```typescript
// on-helper.ts (browser)
import { main, each, on } from 'effection';

await main(function*() {
  const button = document.querySelector('button')!;
  
  // on() creates a stream from any EventTarget
  for (const event of yield* each(on(button, 'click'))) {
    console.log('Clicked!', event);
    yield* each.next();
  }
});
```

For Node.js EventEmitter, you'll typically create your own helper as shown above.

---

## Signal Closing

Like channels, signals can be closed (optionally with a final value):

```typescript
// signal-closing.ts
import type { Signal } from 'effection';
import { main, createSignal, spawn, sleep, each } from 'effection';

await main(function*() {
  const signal: Signal<number, string> = createSignal<number, string>();
  
  // Producer
  setTimeout(() => signal.send(1), 100);
  setTimeout(() => signal.send(2), 200);
  setTimeout(() => signal.close('done!'), 300);  // Close with final value
  
  // Consumer
  const subscription = yield* signal;
  
  let result = yield* subscription.next();
  while (!result.done) {
    console.log('Value:', result.value);
    result = yield* subscription.next();
  }
  
  console.log('Final:', result.value); // 'done!'
});
```

---

## When to Use Signals vs Channels

| Scenario | Use |
|----------|-----|
| Both producer and consumer in Effection | `Channel` |
| Producer is a callback/external code | `Signal` |
| DOM/browser events | `Signal` or `on()` |
| Node.js EventEmitter | `Signal` |
| Communication between operations | `Channel` |

---

## Mini-Exercise: Keyboard Input Stream

```typescript
// keyboard-stream.ts
import type { Operation, Signal } from 'effection';
import { main, createSignal, spawn, sleep, each, ensure } from 'effection';
import * as readline from 'readline';

function* keyboardInput(): Operation<void> {
  const lines: Signal<string, void> = createSignal<string, void>();
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  rl.on('line', lines.send);
  
  yield* ensure(() => {
    rl.close();
    lines.close();
  });
  
  console.log('Type messages (Ctrl+C to exit):\n');
  
  for (const line of yield* each(lines)) {
    console.log(`You typed: "${line}"`);
    yield* each.next();
  }
}

await main(function*() {
  yield* keyboardInput();
});
```

Run it: `npx tsx keyboard-stream.ts`

Type lines and see them echoed back. Press Ctrl+C to exit cleanly.

---

## Key Takeaways

1. **Signals bridge callbacks to Effection** - `send()` is a regular function
2. **Use signals for external events** - DOM, EventEmitter, callbacks
3. **Channels for internal communication** - between Effection operations
4. **Combine with resources** - for clean setup/teardown of event listeners
5. **Signals and channels stream the same way** - use `for yield* each` for both

---

## Next Up

Now that we've seen both Channels and Signals, you might have noticed they work the same way when consuming them. That's because they're both **Streams**. In the next chapter, we'll explore [Streams](./09-streams.md) - the unifying concept behind all sequence producers in Effection.
