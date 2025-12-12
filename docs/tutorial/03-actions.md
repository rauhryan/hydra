# Chapter 1.3: Actions - Bridging the Callback World

Most JavaScript APIs use callbacks: `setTimeout`, event listeners, XHR, WebSockets. How do we bring these into Effection's world of operations?

The answer is **actions**.

---

## The Promise Constructor Pattern

You've probably written this pattern before:

```typescript
// promise-sleep.ts
function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}
```

The Promise constructor takes an "executor" function that receives `resolve` and `reject`. When your callback fires, you call `resolve()` to complete the promise.

---

## The Action Constructor

Effection's `action()` works similarly, but with one critical difference:

```typescript
// action-sleep.ts
import type { Operation } from 'effection';
import { action } from 'effection';

function sleep(ms: number): Operation<void> {
  return action(function*(resolve, reject) {
    const timeoutId = setTimeout(resolve, ms);
    return () => clearTimeout(timeoutId);  // Cleanup function - required!
  });
}
```

Actions **must** return a cleanup function. This is the magic that prevents leaked effects!

---

## The Cleanup Function

The cleanup function is called when:
1. The action resolves (via `resolve()`)
2. The action rejects (via `reject()`)
3. The action is halted (parent scope ends)

```typescript
// sleep-with-logging.ts
import type { Operation } from 'effection';
import { main, action, race } from 'effection';

function sleep(ms: number): Operation<void> {
  return action(function*(resolve, reject) {
    console.log(`Starting ${ms}ms timer`);
    const timeoutId = setTimeout(() => {
      console.log(`${ms}ms timer completed`);
      resolve();
    }, ms);
    
    return () => {
      console.log(`Cleaning up ${ms}ms timer`);
      clearTimeout(timeoutId);
    };
  });
}

await main(function*() {
  yield* race([sleep(10), sleep(1000)]);
  console.log('Race done!');
});
```

Output:
```
Starting 10ms timer
Starting 1000ms timer
10ms timer completed
Cleaning up 10ms timer
Cleaning up 1000ms timer
Race done!
```

Both timers are cleaned up! The 1000ms timer is halted when the 10ms timer wins.

---

## A More Complex Example: Fetch with XHR

Here's how to wrap XHR:

```typescript
// xhr-fetch.ts
import type { Operation } from 'effection';
import { main, action, race } from 'effection';

function* fetch(url: string): Operation<string> {
  return yield* action<string>(function*(resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.onload = () => resolve(xhr.responseText);
    xhr.onerror = () => reject(new Error(xhr.statusText));
    xhr.send();
    
    return () => xhr.abort();  // Cancel request on cleanup!
  });
}

// If you race two fetch operations, the loser's HTTP request is actually cancelled!
await main(function*() {
  const weather: string = yield* race([
    fetch('https://api.weather1.com/current'),
    fetch('https://api.weather2.com/current'),
  ]);
  console.log(weather);
});
```

---

## The Action API

The `action()` function signature:

```typescript
function action<T>(
  executor: (
    resolve: (value: T) => void,
    reject: (error: Error) => void
  ) => (() => void)
): Operation<T>
```

- `resolve(value)` - Complete the action successfully with a value
- `reject(error)` - Complete the action with an error
- Return value - A cleanup function (required!)

---

## Using `action()` with Event Listeners

Here's how to wait for a single event:

```typescript
// once.ts
import type { Operation } from 'effection';
import { main, action } from 'effection';

function once<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  eventName: K
): Operation<HTMLElementEventMap[K]> {
  return action(function*(resolve, reject) {
    const handler = (event: HTMLElementEventMap[K]) => resolve(event);
    
    target.addEventListener(eventName, handler);
    
    return () => target.removeEventListener(eventName, handler);
  });
}

// Usage (in a browser context):
// await main(function*() {
//   console.log('Click the button...');
//   const event = yield* once(button, 'click');
//   console.log('Button clicked!', event);
// });
```

If the operation is halted before the click, the event listener is removed.

---

## Node.js Event Example

Here's a more practical Node.js example:

```typescript
// once-node.ts
import type { Operation } from 'effection';
import { main, action } from 'effection';
import { EventEmitter } from 'events';

function once<T>(
  emitter: EventEmitter,
  eventName: string
): Operation<T> {
  return action<T>(function*(resolve, reject) {
    const handler = (value: T) => resolve(value);
    const errorHandler = (error: Error) => reject(error);
    
    emitter.on(eventName, handler);
    emitter.on('error', errorHandler);
    
    return () => {
      emitter.off(eventName, handler);
      emitter.off('error', errorHandler);
    };
  });
}

// Demo
await main(function*() {
  const emitter = new EventEmitter();
  
  // Schedule an event to fire
  setTimeout(() => emitter.emit('data', { message: 'Hello!' }), 100);
  
  const data: { message: string } = yield* once(emitter, 'data');
  console.log('Received:', data.message);
});
```

---

## Yielding Inside Actions

The executor is a generator, so you can yield to other operations:

```typescript
// delayed-action.ts
import type { Operation } from 'effection';
import { main, action, sleep } from 'effection';

function* delayedAction(delay: number): Operation<string> {
  return yield* action<string>(function*(resolve, reject) {
    // Do some async setup
    yield* sleep(delay);
    
    // Then set up the callback
    const id = setTimeout(() => resolve('done!'), 1000);
    return () => clearTimeout(id);
  });
}

await main(function*() {
  const result: string = yield* delayedAction(500);
  console.log(result); // 'done!'
});
```

This is powerful for complex initialization sequences.

---

## Error Handling in Actions

Use `reject()` to signal errors:

```typescript
// load-image.ts
import type { Operation } from 'effection';
import { main, action } from 'effection';

function loadImage(url: string): Operation<HTMLImageElement> {
  return action<HTMLImageElement>(function*(resolve, reject) {
    const img = new Image();
    
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${url}`));
    
    img.src = url;
    
    return () => {
      img.src = '';  // Cancel loading
    };
  });
}

// The error propagates like any other error in Effection:
// await main(function*() {
//   try {
//     const img = yield* loadImage('https://example.com/missing.png');
//   } catch (error) {
//     console.log('Image failed to load:', error.message);
//   }
// });
```

---

## Mini-Exercise: Build Your Own Sleep

Create `my-sleep.ts`:

```typescript
// my-sleep.ts
import type { Operation } from 'effection';
import { main, action, race } from 'effection';

// Implement sleep using action()
function sleep(ms: number): Operation<void> {
  return action(function*(resolve, reject) {
    console.log(`Starting ${ms}ms timer`);
    const id = setTimeout(() => {
      console.log(`${ms}ms timer completed`);
      resolve();
    }, ms);
    
    return () => {
      console.log(`Cleaning up ${ms}ms timer`);
      clearTimeout(id);
    };
  });
}

await main(function*() {
  console.log('Racing timers...');
  
  yield* race([
    sleep(100),
    sleep(500),
    sleep(1000),
  ]);
  
  console.log('Race complete!');
});
```

Run it: `npx tsx my-sleep.ts`

Expected output:
```
Racing timers...
Starting 100ms timer
Starting 500ms timer
Starting 1000ms timer
100ms timer completed
Cleaning up 100ms timer
Cleaning up 500ms timer
Cleaning up 1000ms timer
Race complete!
```

Notice all timers are cleaned up, but only the 100ms one actually completed!

---

## When to Use Actions

Use `action()` when you need to:

1. **Wrap callback-based APIs** (setTimeout, events, XHR)
2. **Ensure cleanup always happens** (remove listeners, abort requests)
3. **Bridge external callbacks into Effection** (one-time events)

For ongoing streams of events (multiple clicks, WebSocket messages), you'll want Channels and Signals - covered in Part 3.

---

## Key Takeaways

1. **`action()` is like the Promise constructor** - but with mandatory cleanup
2. **Always return a cleanup function** - this is what prevents leaked effects
3. **Cleanup runs in all cases** - resolve, reject, or halt
4. **The executor is a generator** - you can yield to other operations inside it
5. **Actions are for one-time events** - use Signals for streams

---

## Next Up

Now you understand the foundations! In [Chapter 2.1: Spawn](./04-spawn.md), we'll learn how to run multiple operations concurrently.
