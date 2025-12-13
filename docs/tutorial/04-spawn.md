# Chapter 2.1: Spawn - Child Operations

So far, our operations have been sequential - each step waits for the previous one. But real applications need to do multiple things at once: handle requests while listening for new connections, animate UI while fetching data, monitor health while serving traffic.

Enter `spawn()`.

---

## The Concurrency Problem

Let's say we want to fetch data from two different sources:

```typescript
// sequential-fetch.ts
import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* fetchFromAPI(source: string): Operation<string> {
  console.log(`Fetching from ${source}...`);
  yield* sleep(500); // Simulate network delay
  return `Data from ${source}`;
}

await main(function*() {
  console.time('total');

  const dataA: string = yield* fetchFromAPI('api-a');
  const dataB: string = yield* fetchFromAPI('api-b');

  console.log(dataA, dataB);
  console.timeEnd('total'); // ~1000ms - sequential!
});
```

This works, but it's slow - we fetch one, wait, then fetch the other. What if each fetch takes 500ms? We'd wait 1000ms total instead of 500ms.

---

## The Wrong Way: Using `run()`

You might try using `run()` to start concurrent tasks, but this breaks structured concurrency:

```typescript
// wrong-way.ts - Why run() inside operations breaks structured concurrency
import type { Operation } from 'effection';
import { main, run, spawn, sleep, ensure, scoped } from 'effection';

function* task(name: string): Operation<string> {
  console.log(`[${name}] Started`);
  yield* ensure(() => console.log(`[${name}] Cleanup`));
  yield* sleep(500);
  console.log(`[${name}] Done`);
  return name;
}

await main(function*() {
  // === CORRECT: spawn() creates children that get cleaned up ===
  console.log('=== spawn(): Structured Concurrency ===\n');

  yield* scoped(function*() {
    yield* spawn(() => task('child-a'));
    yield* spawn(() => task('child-b'));

    yield* sleep(100);
    console.log('Scope exiting early...\n');
    // When this scope exits, spawned children are halted immediately
  });

  console.log('Result: Children were halted and cleaned up (no "Done" logged)!\n');
  console.log('='.repeat(50) + '\n');

  // === WRONG: run() creates independent tasks that escape the scope ===
  console.log('=== run(): Breaking Structured Concurrency ===\n');

  yield* scoped(function*() {
    // DON'T DO THIS - these tasks escape to the global scope!
    run(() => task('orphan-a'));
    run(() => task('orphan-b'));

    yield* sleep(100);
    console.log('Scope exiting early...\n');
    // Orphaned tasks keep running - they are NOT children of this scope
  });

  console.log('Result: Orphans were NOT halted - still running!\n');

  // Wait to show orphaned tasks complete on their own
  yield* sleep(600);
  console.log('\n--- Orphans finished on their own (not structured) ---');
});
```

Output:
```
=== spawn(): Structured Concurrency ===

[child-a] Started
[child-b] Started
Scope exiting early...

[child-b] Cleanup
[child-a] Cleanup
Result: Children were halted and cleaned up (no "Done" logged)!

==================================================

=== run(): Breaking Structured Concurrency ===

[orphan-a] Started
[orphan-b] Started
Scope exiting early...

Result: Orphans were NOT halted - still running!

[orphan-a] Done
[orphan-a] Cleanup
[orphan-b] Done
[orphan-b] Cleanup

--- Orphans finished on their own (not structured) ---
```

Notice the difference:
- **spawn()**: When the scope exits, children are **halted immediately** - "Cleanup" runs but "Done" never logs
- **run()**: Tasks **escape** the scope and keep running - both "Done" and "Cleanup" log later

This is the core problem: `run()` creates tasks in the global scope, not as children of the current operation.

---

## The Right Way: `spawn()`

```typescript
// spawn-example.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

function* fetchFromAPI(source: string): Operation<string> {
  console.log(`Fetching from ${source}...`);
  yield* sleep(500);
  return `Data from ${source}`;
}

await main(function*() {
  console.time('total');

  const taskA: Task<string> = yield* spawn(() => fetchFromAPI('api-a'));
  const taskB: Task<string> = yield* spawn(() => fetchFromAPI('api-b'));

  const dataA: string = yield* taskA;
  const dataB: string = yield* taskB;

  console.log(dataA, dataB);
  console.timeEnd('total'); // ~500ms - parallel!
});
```

Now both operations are **children of main**. The task hierarchy looks like:

```
+-- main
    |
    +-- fetchFromAPI('api-a')
    |
    +-- fetchFromAPI('api-b')
```

---

## The Structured Concurrency Guarantee

When you use `spawn()`, you get two guarantees:

### 1. Children can't outlive their parent

When the parent operation ends (for any reason), all children are halted:

```typescript
// children-halted.ts
import type { Operation } from 'effection';
import { main, spawn, sleep } from 'effection';

await main(function*() {
  yield* spawn(function*(): Operation<void> {
    let count = 0;
    while (true) {
      console.log(`tick ${++count}`);
      yield* sleep(100);
    }
  });

  yield* sleep(550);
  console.log('main ending...');
  // main ends, the infinite loop is halted!
});
```

Output:
```
tick 1
tick 2
tick 3
tick 4
tick 5
main ending...
```

After ~550ms, main ends and the spawned task is automatically stopped.

### 2. Child errors propagate to the parent

When a spawned child fails, it crashes the parent scope. But here's the key: **all sibling tasks are halted and cleaned up BEFORE the error propagates**. This is structured concurrency in action.

```typescript
// error-propagation.ts - Demonstrates structured error handling
//
// Key insight: When a spawned child fails, it crashes the parent scope.
// All sibling tasks are halted and cleaned up BEFORE the error propagates.
// You can catch the error at the main() boundary using .catch()

import type { Operation } from 'effection';
import { main, spawn, sleep, ensure } from 'effection';

function* worker(id: number, shouldFail: boolean): Operation<void> {
  console.log(`[worker-${id}] Starting`);
  yield* ensure(() => console.log(`[worker-${id}] Cleanup`));

  yield* sleep(shouldFail ? 100 : 500);

  if (shouldFail) {
    throw new Error(`Worker ${id} failed!`);
  }

  console.log(`[worker-${id}] Completed`);
}

await main(function*() {
  yield* spawn(() => worker(1, true));   // Will fail after 100ms
  yield* spawn(() => worker(2, false));  // Will be halted before completing
  yield* spawn(() => worker(3, false));  // Will be halted before completing

  yield* sleep(1000);
  console.log('Never reached');
}).catch(error => {
  console.log(`\nCaught error: ${(error as Error).message}`);
  console.log('All workers were cleaned up before we got here!');
});
```

Output:
```
[worker-1] Starting
[worker-2] Starting
[worker-3] Starting
[worker-1] Cleanup
[worker-3] Cleanup
[worker-2] Cleanup

Caught error: Worker 1 failed!
All workers were cleaned up before we got here!
```

Notice:
- All three workers start
- When worker-1 fails, **all workers get cleaned up** (including the failing one)
- No "Completed" logs - workers 2 and 3 were halted before they could finish
- The error is caught via `.catch()` on the `main()` Promise
- Cleanup happens **before** the error handler runs

---

## Spawn Returns a Task

The `spawn()` operation returns a `Task<T>` that you can:

1. **Yield to get the result**: `const result = yield* task`
2. **Halt explicitly**: `yield* task.halt()`

```typescript
// task-result.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

await main(function*() {
  const task: Task<string> = yield* spawn(function*(): Operation<string> {
    yield* sleep(1000);
    return 'completed!';
  });

  // Wait for it to finish
  const result: string = yield* task;
  console.log(result); // 'completed!'
});
```

---

## Fire and Forget

Sometimes you don't care about the result:

```typescript
// fire-and-forget.ts
import type { Operation } from 'effection';
import { main, spawn, sleep } from 'effection';

function* doMainWork(): Operation<void> {
  console.log('Doing main work...');
  yield* sleep(3000);
  console.log('Main work done!');
}

await main(function*() {
  // Start a background heartbeat - we don't need its result
  yield* spawn(function*(): Operation<void> {
    while (true) {
      console.log('heartbeat');
      yield* sleep(1000);
    }
  });

  // Do other work...
  yield* doMainWork();

  // When main ends, heartbeat is automatically stopped
});
```

Output:
```
heartbeat
Doing main work...
heartbeat
heartbeat
heartbeat
Main work done!
```

---

## Practical Example: Parallel Data Fetching

```typescript
// parallel-fetch.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

interface User {
  id: number;
  name: string;
}

interface Post {
  id: number;
  title: string;
}

interface Comment {
  id: number;
  text: string;
}

// Simulated API calls
function* fetchUser(id: number): Operation<User> {
  yield* sleep(300);
  return { id, name: `User ${id}` };
}

function* fetchPosts(userId: number): Operation<Post[]> {
  yield* sleep(500);
  return [
    { id: 1, title: 'First Post' },
    { id: 2, title: 'Second Post' },
  ];
}

function* fetchComments(postId: number): Operation<Comment[]> {
  yield* sleep(200);
  return [{ id: 1, text: 'Great post!' }];
}

await main(function*() {
  console.time('total');

  // Fetch user first
  const user: User = yield* fetchUser(1);

  // Then fetch posts and comments in parallel
  const postsTask: Task<Post[]> = yield* spawn(() => fetchPosts(user.id));
  const commentsTask: Task<Comment[]> = yield* spawn(() => fetchComments(1));

  const posts: Post[] = yield* postsTask;
  const comments: Comment[] = yield* commentsTask;

  console.log({ user, posts, comments });
  console.timeEnd('total'); // ~800ms, not 1000ms!
});
```

---

## Understanding Scope Lifetime

The relationship between parent and child scopes has subtle behaviors that can trip you up. Let's explore 4 key scenarios:

```typescript
// hierarchy.ts - Understanding scope lifetime and task execution
//
// This example demonstrates 4 key behaviors that can trip you up:
// 1. Parent must yield for children to run
// 2. Spawn is lazy - child starts when parent yields
// 3. Cleanup happens deepest-first
// 4. Scope lifetime determines child lifetime

import type { Operation } from 'effection';
import { main, spawn, sleep, ensure, scoped } from 'effection';

await main(function*() {
  // ═══════════════════════════════════════════════════════════════════
  // Scenario 1: Parent must yield for children to run
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 1: Parent must yield for children to run ═══\n');

  yield* spawn(function*() {
    console.log('[parent] Starting');

    // Spawn a grandchild...
    yield* spawn(function*() {
      console.log('[grandchild] Running!'); // Will this print?
      yield* sleep(100);
      console.log('[grandchild] Done!');
    });

    // ...but return immediately without yielding!
    console.log('[parent] Returning immediately');
    return;
    // Parent scope ends, grandchild never gets a chance to run!
  });

  yield* sleep(200);
  console.log('Result: Grandchild never ran because parent returned immediately!\n');

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 2: Spawn is lazy - child starts when parent yields
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 2: Spawn is lazy ═══\n');

  yield* spawn(function*() {
    console.log('[1] Before spawn');

    yield* spawn(function*() {
      yield* ensure(() => console.log('[child] Exiting (halted!)'));
      console.log('[3] Child started');
      yield* sleep(50);
      console.log('[child] Finished'); // Never prints!
    });

    console.log('[2] After spawn, before yield');
    yield* sleep(0); // Yield control - NOW child runs
    console.log('[4] After yield');

    yield* sleep(0);
    console.log('[5] Parent exiting');
  });

  yield* sleep(200);
  console.log(`
Timeline:
  [1] → [2] → yield → [3] → child sleeps...
                        ↓
               [4] → [5] → parent exits
                        ↓
               child halted! (never prints "Finished")

Result: Child started AFTER parent yielded, but was halted when parent exited!
`);

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 3: Cleanup happens deepest-first
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 3: Cleanup order (deepest first) ═══\n');

  yield* scoped(function*() {
    yield* ensure(() => console.log('[grandparent] Cleanup (last)'));

    yield* spawn(function*() {
      yield* ensure(() => console.log('[parent] Cleanup (second)'));

      yield* spawn(function*() {
        yield* ensure(() => console.log('[child] Cleanup (first)'));
        yield* sleep(1000); // Will be halted
      });

      yield* sleep(1000); // Will be halted
    });

    yield* sleep(50); // Let tasks start, then scope ends
  });

  console.log('Result: Cleanup ran child → parent → grandparent!\n');

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 4: Scope lifetime determines child lifetime
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 4: Scope lifetime limits children ═══\n');

  yield* scoped(function*() {
    yield* spawn(function*() {
      let tick = 0;
      while (true) {
        console.log(`[ticker] tick ${++tick}`);
        yield* sleep(100);
      }
    });

    yield* sleep(350); // Scope lives for ~3 ticks
    console.log('[scope] Ending...');
  });

  console.log('[main] Scope ended - ticker is gone!\n');
  yield* sleep(200); // Prove ticker isn't running anymore

  console.log('═══ All scenarios complete ═══');
});
```

Output:
```
═══ Scenario 1: Parent must yield for children to run ═══

[parent] Starting
[parent] Returning immediately
Result: Grandchild never ran because parent returned immediately!

═══ Scenario 2: Spawn is lazy ═══

[1] Before spawn
[2] After spawn, before yield
[3] Child started
[4] After yield
[5] Parent exiting
[child] Exiting (halted!)

Timeline:
  [1] → [2] → yield → [3] → child sleeps...
                        ↓
               [4] → [5] → parent exits
                        ↓
               child halted! (never prints "Finished")

Result: Child started AFTER parent yielded, but was halted when parent exited!

═══ Scenario 3: Cleanup order (deepest first) ═══

[child] Cleanup (first)
[parent] Cleanup (second)
[grandparent] Cleanup (last)
Result: Cleanup ran child → parent → grandparent!

═══ Scenario 4: Scope lifetime limits children ═══

[ticker] tick 1
[ticker] tick 2
[ticker] tick 3
[ticker] tick 4
[scope] Ending...
[main] Scope ended - ticker is gone!

═══ All scenarios complete ═══
```

### Key Takeaways

1. **Children need the parent to yield** - If a parent returns immediately after spawning, the child never runs
2. **Spawn is lazy** - The child doesn't start until the parent yields control (via `sleep`, `suspend`, or another operation)
3. **Cleanup is deepest-first** - Grandchildren clean up before children, children before parents
4. **Scope = lifetime** - When a scope ends, all its children are halted immediately

---

## Mini-Exercise: Concurrent Countdown

Create `parallel-countdown.ts`:

```typescript
// parallel-countdown.ts
import type { Operation, Task } from 'effection';
import { main, spawn, sleep } from 'effection';

function* countdown(name: string, seconds: number): Operation<string> {
  for (let i = seconds; i > 0; i--) {
    console.log(`${name}: ${i}`);
    yield* sleep(1000);
  }
  console.log(`${name}: Done!`);
  return `${name} finished`;
}

await main(function*() {
  console.log('Starting parallel countdowns...\n');

  const task1: Task<string> = yield* spawn(() => countdown('Alpha', 3));
  const task2: Task<string> = yield* spawn(() => countdown('Beta', 5));
  const task3: Task<string> = yield* spawn(() => countdown('Gamma', 2));

  // Wait for all to complete
  const result1: string = yield* task1;
  const result2: string = yield* task2;
  const result3: string = yield* task3;

  console.log('\nAll done!');
  console.log(result1, result2, result3);
});
```

Run it: `npx tsx parallel-countdown.ts`

Now try pressing Ctrl+C while it's running - all countdowns stop immediately!

---

## Key Takeaways

1. **`spawn()` creates child operations** - bound to the parent's lifetime
2. **Children can't outlive their parent** - automatic cleanup when parent ends
3. **Child errors crash the parent** - which then halts all other children
4. **`spawn()` returns a Task** - yield to it to get the result
5. **This is structured concurrency** - the hierarchy is always well-defined

---

## Next Up

Spawning tasks individually works, but there are patterns so common that Effection provides built-in combinators. Let's explore [all() and race()](./05-combinators.md).
