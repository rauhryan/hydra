# Chapter 3.1: Channels - Communication Between Operations

So far we've dealt with operations that produce a single value. But what about **sequences** of values over time?

- Messages between workers
- Events in an internal event bus
- Data flowing through a pipeline

Effection has **Channels** for this - a way for operations to communicate with each other.

---

## What's a Channel?

A Channel is a pub/sub system for Effection operations. One operation sends messages, others receive them.

```typescript
// channel-basics.ts
import type { Operation, Channel, Subscription } from 'effection';
import { main, createChannel, spawn, sleep } from 'effection';

await main(function*() {
  // Create a channel that sends strings
  const channel: Channel<string, void> = createChannel<string, void>();

  // Subscribe to the channel
  // When you yield* a channel, you get a Subscription - your personal message queue
  const subscription: Subscription<string, void> = yield* channel;

  // Send some messages in the background
  yield* spawn(function*(): Operation<void> {
    yield* channel.send('hello');
    yield* sleep(100);
    yield* channel.send('world');
    yield* sleep(100);
    yield* channel.close();  // Close the channel
  });

  // Receive messages
  let result = yield* subscription.next();
  while (!result.done) {
    console.log('Received:', result.value);
    result = yield* subscription.next();
  }

  console.log('Channel closed');
});
```

Output:
```
Received: hello
Received: world
Channel closed
```

---

## Important: Subscribe Before Sending

Channels are **not buffered**. If no one is subscribed, messages are dropped:

```typescript
// dropped-messages.ts
import type { Channel, Subscription } from 'effection';
import { main, createChannel } from 'effection';

await main(function*() {
  const channel: Channel<string, void> = createChannel<string, void>();

  // Send before subscribing - message is LOST!
  yield* channel.send('this is lost');

  // Now subscribe
  const subscription: Subscription<string, void> = yield* channel;

  yield* channel.send('this is received');

  const result = yield* subscription.next();
  console.log(result.value); // 'this is received'
});
```

---

## The `for yield* each` Pattern

Manually calling `next()` is tedious. Use `each` for cleaner iteration:

```typescript
// each-pattern.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

await main(function*() {
  const channel: Channel<number, void> = createChannel<number, void>();

  // Producer
  yield* spawn(function*(): Operation<void> {
    for (let i = 1; i <= 5; i++) {
      yield* channel.send(i);
      yield* sleep(100);
    }
    yield* channel.close();
  });

  // Consumer with each()
  for (const value of yield* each(channel)) {
    console.log('Got:', value);
    yield* each.next();  // REQUIRED!
  }

  console.log('Done');
});
```

Output:
```
Got: 1
Got: 2
Got: 3
Got: 4
Got: 5
Done
```

**Important**: You MUST call `yield* each.next()` at the end of each loop iteration!

---

## Why `yield* each.next()`?

This might seem strange. The reason is that it allows you to do async work between receiving a value and requesting the next one:

```typescript
// async-processing.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

await main(function*() {
  const channel: Channel<string, void> = createChannel<string, void>();

  yield* spawn(function*(): Operation<void> {
    yield* channel.send('task-1');
    yield* channel.send('task-2');
    yield* channel.send('task-3');
    yield* channel.close();
  });

  for (const task of yield* each(channel)) {
    console.log('Processing:', task);
    yield* sleep(500);  // Simulate slow processing
    console.log('Finished:', task);
    yield* each.next();  // Now request next item
  }
});
```

This gives you backpressure control - you only request the next item when you're ready.

---

## Multiple Subscribers

Channels support multiple subscribers - each gets their own copy of every message:

```typescript
// multiple-subscribers.ts
import type { Operation, Channel, Subscription } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

await main(function*() {
  const channel: Channel<string, void> = createChannel<string, void>();

  // Two subscribers
  yield* spawn(function*(): Operation<void> {
    console.log('Subscriber A starting');
    for (const msg of yield* each(channel)) {
      console.log('A received:', msg);
      yield* each.next();
    }
    console.log('Subscriber A done');
  });

  yield* spawn(function*(): Operation<void> {
    console.log('Subscriber B starting');
    for (const msg of yield* each(channel)) {
      console.log('B received:', msg);
      yield* each.next();
    }
    console.log('Subscriber B done');
  });

  // Give subscribers time to start
  yield* sleep(10);

  // Send messages
  yield* channel.send('hello');
  yield* channel.send('world');
  yield* channel.close();

  yield* sleep(100);
});
```

Output:
```
Subscriber A starting
Subscriber B starting
A received: hello
B received: hello
A received: world
B received: world
Subscriber A done
Subscriber B done
```

Each subscriber has their own queue and receives all messages independently.

---

## Practical Example: Event Bus

Use a channel as an internal event bus:

```typescript
// event-bus.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

interface AppEvent {
  type: string;
  payload: unknown;
}

// Create a global event bus
const eventBus: Channel<AppEvent, void> = createChannel<AppEvent, void>();

// Logger that prints all events
function* eventLogger(): Operation<void> {
  for (const event of yield* each(eventBus)) {
    console.log(`[LOG] ${event.type}:`, event.payload);
    yield* each.next();
  }
}

// Analytics that counts events
function* analytics(): Operation<void> {
  const counts: Record<string, number> = {};

  for (const event of yield* each(eventBus)) {
    counts[event.type] = (counts[event.type] || 0) + 1;
    console.log(`[ANALYTICS] Event counts:`, counts);
    yield* each.next();
  }
}

await main(function*() {
  // Start consumers
  yield* spawn(eventLogger);
  yield* spawn(analytics);

  yield* sleep(10);

  // Emit some events
  yield* eventBus.send({ type: 'user.login', payload: { userId: 1 } });
  yield* eventBus.send({ type: 'page.view', payload: { page: '/home' } });
  yield* eventBus.send({ type: 'user.login', payload: { userId: 2 } });

  yield* sleep(100);
});
```

Output:
```
[LOG] user.login: { userId: 1 }
[ANALYTICS] Event counts: { 'user.login': 1 }
[LOG] page.view: { page: '/home' }
[ANALYTICS] Event counts: { 'user.login': 1, 'page.view': 1 }
[LOG] user.login: { userId: 2 }
[ANALYTICS] Event counts: { 'user.login': 2, 'page.view': 1 }
```

---

## Closing Channels with Data

Channels can pass a final value when closing:

```typescript
// close-with-data.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep } from 'effection';

interface Summary {
  totalMessages: number;
}

await main(function*() {
  const channel: Channel<string, Summary> = createChannel<string, Summary>();

  yield* spawn(function*(): Operation<void> {
    yield* channel.send('one');
    yield* channel.send('two');
    yield* channel.send('three');
    yield* channel.close({ totalMessages: 3 });
  });

  const subscription = yield* channel;

  let result = yield* subscription.next();
  while (!result.done) {
    console.log('Message:', result.value);
    result = yield* subscription.next();
  }

  console.log('Summary:', result.value); // { totalMessages: 3 }
});
```

---

## Mini-Exercise: Chat Room

Create `chat-room.ts`:

```typescript
// chat-room.ts
import type { Operation, Channel } from 'effection';
import { main, createChannel, spawn, sleep, each } from 'effection';

interface ChatMessage {
  user: string;
  text: string;
  timestamp: Date;
}

const chatChannel: Channel<ChatMessage, void> = createChannel<ChatMessage, void>();

function* chatClient(username: string): Operation<void> {
  console.log(`${username} joined the chat`);

  for (const msg of yield* each(chatChannel)) {
    if (msg.user !== username) {
      console.log(`[${username}'s view] ${msg.user}: ${msg.text}`);
    }
    yield* each.next();
  }
}

function* sendMessage(user: string, text: string): Operation<void> {
  yield* chatChannel.send({
    user,
    text,
    timestamp: new Date(),
  });
}

await main(function*() {
  // Start chat clients
  yield* spawn(() => chatClient('Alice'));
  yield* spawn(() => chatClient('Bob'));
  yield* spawn(() => chatClient('Charlie'));

  yield* sleep(10);

  // Simulate conversation
  yield* sendMessage('Alice', 'Hello everyone!');
  yield* sleep(100);
  yield* sendMessage('Bob', 'Hi Alice!');
  yield* sleep(100);
  yield* sendMessage('Charlie', 'Good morning!');

  yield* sleep(200);
});
```

Run it: `npx tsx chat-room.ts`

---

## Key Takeaways

1. **Channels are internal pub/sub** - for communication between Effection operations
2. **Subscribe before sending** - channels don't buffer messages
3. **Use `for yield* each`** - cleaner than manual `next()` calls
4. **Always call `yield* each.next()`** - at the end of each loop iteration
5. **Multiple subscribers** - each gets their own copy of every message

---

## But Wait... What About Callbacks?

There's a limitation we haven't addressed. Look at this:

```typescript
// This doesn't work!
await main(function*() {
  const channel = createChannel<MouseEvent, void>();
  
  document.addEventListener('click', (event) => {
    yield* channel.send(event);  // SyntaxError! Can't yield* in a callback
  });
});
```

`channel.send()` is an **operation** - you can only call it with `yield*`. But callbacks are plain JavaScript functions!

This is a fundamental problem:
- Channels work great when both producer and consumer are Effection operations
- But external events (DOM clicks, Node.js EventEmitters, timers) come from callbacks

Remember the `firstSuccess` combinator from [Chapter 05](./05-combinators.md)? We solved the polling problem with something called `createSignal()`:

```typescript
const success = createSignal<T, never>();
// ...
success.send(value);  // No yield*! It's a plain function call
```

That's the key difference. In the next chapter, we'll learn about **Signals** - and finally understand why that solution worked so elegantly.

---

## Next Up

[Signals](./08-signals.md) - bridging callbacks and external events into structured concurrency.
