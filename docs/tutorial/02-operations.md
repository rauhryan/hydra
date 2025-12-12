# Chapter 1.2: Operations - The Lazy Alternative

The fundamental unit of async work in `async/await` is the **Promise**. In Effection, it's the **Operation**.

The critical difference? **Operations are lazy.**

---

## Promises Are Eager

When you call an async function, it starts executing immediately:

```typescript
// eager-promise.ts
async function sayHello(): Promise<void> {
  console.log('Hello World!');
}

sayHello(); // Logs immediately, even without await!
```

The function runs whether you `await` it or not. The promise is already in-flight.

---

## Operations Are Recipes

In contrast, calling a generator function does... nothing:

```typescript
// lazy-generator.ts
function* sayHello(): Generator<void, void, void> {
  console.log('Hello World!');
}

sayHello(); // Nothing happens!
```

A generator function returns an **iterator object** - essentially a recipe for work. No code runs until something explicitly iterates through it.

This laziness is a feature, not a bug! It means operations describe **what should happen**, not **what is happening**.

---

## Running Operations with `run()`

To actually execute an operation, use the `run()` function:

```typescript
// run-example.ts
import { run } from 'effection';

run(function*() {
  console.log('Hello World!');
});
// Output: Hello World!
```

The `run()` function:
1. Takes an operation (a generator function)
2. Starts executing it
3. Returns a **Task** (which is both an Operation and a Promise)

Because the task is also a Promise, you can `await` it:

```typescript
// run-with-await.ts
import { run } from 'effection';

try {
  await run(function*() {
    throw new Error('oh no!');
  });
} catch (error) {
  console.error(error); // Error: oh no!
}
```

---

## The `main()` Entry Point

For most programs, use `main()` instead of `run()`:

```typescript
// main-example.ts
import { main } from 'effection';

await main(function*() {
  console.log('Starting...');
  // your program here
});
```

`main()` provides several benefits over `run()`:

1. **Catches and prints errors** - no need for try/catch at the top level
2. **Handles process signals** - Ctrl+C triggers graceful shutdown
3. **Ensures cleanup** - guarantees all finally blocks run

Use `run()` only when you need fine-grained control (like testing).

---

## Composing with `yield*`

The `yield*` keyword is Effection's equivalent of `await`. Use it to run one operation from within another:

```typescript
// yield-star-example.ts
import { main, sleep } from 'effection';

await main(function*() {
  console.log('Starting...');
  yield* sleep(1000);
  console.log('One second later!');
});
```

The `sleep()` operation pauses execution for the specified duration, then resumes.

---

## Nesting Operations

Operations compose beautifully. You can call operations from operations:

```typescript
// countdown.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* countdown(n: number): Operation<void> {
  for (let i = n; i > 0; i--) {
    console.log(i);
    yield* sleep(1000);
  }
  console.log('Liftoff!');
}

await main(function*() {
  yield* countdown(3);
});
```

Output:
```
3
2
1
Liftoff!
```

There's no limit to nesting depth. Complex programs are built by composing simple operations.

---

## The Return Type: `Operation<T>`

Operations can return values, just like async functions:

```typescript
// slow-add.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* slowAdd(a: number, b: number): Operation<number> {
  yield* sleep(1000);
  return a + b;
}

await main(function*() {
  const result: number = yield* slowAdd(2, 3);
  console.log(`Result: ${result}`); // Result: 5
});
```

The `Operation<T>` type indicates what value the operation will produce when it completes.

---

## Regular JavaScript Works

Inside operations, you can use all normal JavaScript constructs:

```typescript
// regular-js.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* somethingDangerous(): Operation<void> {
  throw new Error('Danger!');
}

await main(function*() {
  // Variables
  let count = 0;
  
  // Conditionals
  if (Math.random() > 0.5) {
    count = 10;
  }
  
  // Loops
  while (count > 0) {
    console.log(count);
    count--;
    yield* sleep(100);
  }
  
  // Try/catch
  try {
    yield* somethingDangerous();
  } catch (error) {
    console.log('Caught:', error);
  }
});
```

The only rule: use `yield*` instead of `await` for async operations.

---

## Mini-Exercise: Countdown Timer

Create a file called `countdown.ts`:

```typescript
// countdown.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* countdown(seconds: number): Operation<void> {
  for (let i = seconds; i > 0; i--) {
    console.log(`${i}...`);
    yield* sleep(1000);
  }
  console.log('Done!');
}

await main(function*() {
  yield* countdown(5);
});
```

Run it: `npx tsx countdown.ts`

Now try pressing Ctrl+C while it's counting. Notice that it stops immediately - no leaked timers!

---

## Quick Reference

| Async/Await | Effection |
|-------------|-----------|
| `Promise<T>` | `Operation<T>` |
| `await` | `yield*` |
| `async function` | `function*` |
| `new Promise(...)` | `action(...)` |
| Start implicitly | Must call `run()` or `main()` |

---

## Key Takeaways

1. **Operations are lazy** - they don't do anything until executed
2. **`run()` executes operations** - returns a Task you can await
3. **`main()` is the preferred entry point** - handles errors and signals
4. **`yield*` composes operations** - the async equivalent of await
5. **Regular JS works** - loops, conditionals, try/catch all work normally

---

## Next Up

We've seen how to run operations, but how do we bridge callback-based APIs like `setTimeout`? That's where [Actions](./03-actions.md) come in.
