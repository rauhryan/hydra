# Chapter 3.3: Streams - The Unifying Concept

We've now learned two ways to produce sequences of values:

- **Channels** - for communication between Effection operations
- **Signals** - for bridging external events into Effection

You may have noticed they work the same way when consuming:

```typescript
// Consuming a Channel
for (const msg of yield* each(channel)) {
  console.log(msg);
  yield* each.next();
}

// Consuming a Signal
for (const event of yield* each(signal)) {
  console.log(event);
  yield* each.next();
}
```

That's because both Channels and Signals are **Streams**.

---

## What is a Stream?

A `Stream` is a type you can import from Effection:

```typescript
import type { Stream, Subscription } from 'effection';

// Stream is just a type alias:
type Stream<T, TReturn> = Operation<Subscription<T, TReturn>>;
```

In plain English: **a Stream is an Operation that, when you `yield*` it, gives you a Subscription.**

- **Stream** = stateless recipe (like an AsyncIterable)
- **Subscription** = stateful queue you read from (like an AsyncIterator)

```typescript
// Channel implements Stream
const channel: Channel<string, void> = createChannel();
const sub: Subscription<string, void> = yield* channel;  // yield* a Stream → get a Subscription

// Signal implements Stream  
const signal: Signal<string, void> = createSignal();
const sub: Subscription<string, void> = yield* signal;   // same pattern!
```

---

## Each `yield*` Creates a Fresh Subscription

This is the key insight: every time you `yield*` a Stream, you get a **new, independent** Subscription with its own queue.

```typescript
// stream-vs-subscription.ts
import type { Channel, Subscription } from 'effection';
import { main, createChannel, spawn, sleep } from 'effection';

await main(function*() {
  const channel: Channel<number, void> = createChannel<number, void>();

  // Each yield* creates a NEW subscription with its own queue
  const sub1: Subscription<number, void> = yield* channel;
  const sub2: Subscription<number, void> = yield* channel;

  yield* spawn(function*() {
    yield* channel.send(1);
    yield* channel.send(2);
  });

  yield* sleep(10);

  // Both subscriptions receive ALL messages independently
  console.log('sub1:', (yield* sub1.next()).value); // 1
  console.log('sub1:', (yield* sub1.next()).value); // 2
  console.log('sub2:', (yield* sub2.next()).value); // 1
  console.log('sub2:', (yield* sub2.next()).value); // 2
});
```

```
Channel (a Stream)
     │
     ├── yield* channel ──> sub1 (its own queue)
     │                        └── receives: 1, 2
     │
     └── yield* channel ──> sub2 (its own queue)
                              └── receives: 1, 2
```

---

## Built-in Stream Producers

Effection provides several functions that return Streams:

### `interval(ms)` - Periodic Ticks

```typescript
import { main, interval, each } from 'effection';

await main(function*() {
  let count = 0;
  
  for (const _ of yield* each(interval(1000))) {
    console.log('tick', ++count);
    if (count >= 3) break;
    yield* each.next();
  }
});
```

Output:
```
tick 1
tick 2
tick 3
```

### `on(target, eventName)` - DOM Events

For browser `EventTarget` objects:

```typescript
import { main, on, each } from 'effection';

await main(function*() {
  const button = document.querySelector('button')!;
  
  for (const event of yield* each(on(button, 'click'))) {
    console.log('Clicked at:', event.clientX, event.clientY);
    yield* each.next();
  }
});
```

### `once(emitter, eventName)` - Single Event

Wait for a single event from a Node.js EventEmitter:

```typescript
import { main, once } from 'effection';
import { EventEmitter } from 'events';

await main(function*() {
  const emitter = new EventEmitter();
  
  setTimeout(() => emitter.emit('ready', { status: 'ok' }), 100);
  
  const event = yield* once(emitter, 'ready');
  console.log('Got event:', event);
});
```

---

## Writing Functions That Accept Any Stream

Because `Stream` is a unifying type, you can write functions that work with Channels, Signals, intervals, or any other Stream:

```typescript
import type { Operation, Stream } from 'effection';
import { each } from 'effection';

// This function works with ANY Stream
function* logAll<T>(stream: Stream<T, unknown>): Operation<void> {
  for (const value of yield* each(stream)) {
    console.log('Value:', value);
    yield* each.next();
  }
}

// Works with a Channel
const channel = createChannel<string, void>();
yield* spawn(() => logAll(channel));

// Works with a Signal
const signal = createSignal<number, void>();
yield* spawn(() => logAll(signal));

// Works with interval
yield* spawn(() => logAll(interval(1000)));
```

---

## Creating Custom Streams

You can create your own Stream by returning an `Operation<Subscription<T, TClose>>`. The easiest way is with a Signal inside a resource:

```typescript
import type { Operation, Stream, Subscription, Signal } from 'effection';
import { resource, createSignal, ensure } from 'effection';
import { EventEmitter } from 'events';

// A custom Stream factory for EventEmitter events
function eventsFrom<T>(
  emitter: EventEmitter,
  eventName: string
): Stream<T, void> {
  return resource<Subscription<T, void>>(function*(provide) {
    const signal: Signal<T, void> = createSignal<T, void>();
    
    const handler = (value: T) => signal.send(value);
    emitter.on(eventName, handler);
    
    yield* ensure(() => {
      emitter.off(eventName, handler);
      signal.close();
    });
    
    const subscription: Subscription<T, void> = yield* signal;
    yield* provide(subscription);
  });
}

// Usage
await main(function*() {
  const emitter = new EventEmitter();
  
  yield* spawn(function*() {
    for (const data of yield* each(eventsFrom<string>(emitter, 'message'))) {
      console.log('Got:', data);
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

## The Stream Type Hierarchy

Here's how it all fits together:

```
Stream<T, TClose> = Operation<Subscription<T, TClose>>
       │
       ├── Channel<T, TClose> extends Stream<T, TClose>
       │     └── createChannel() → Channel
       │
       ├── Signal<T, TClose> extends Stream<T, TClose>
       │     └── createSignal() → Signal
       │
       └── Other Stream producers:
             ├── interval(ms) → Stream<void, never>
             ├── on(target, event) → Stream<Event, never>
             └── Your custom streams!
```

---

## Key Takeaways

1. **Stream is a type alias** - `Operation<Subscription<T, TClose>>`
2. **Channels and Signals are both Streams** - that's why consuming them looks identical
3. **Each `yield*` creates a fresh Subscription** - independent queues
4. **Use `Stream` as a parameter type** - to write functions that accept any stream
5. **Create custom Streams** - with Signals inside resources

---

## Next Up

We've covered communication between operations. But how do we share values across the operation tree without passing them everywhere? That's where [Context](./10-context.md) comes in.
