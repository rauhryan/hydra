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

```typescript
// error-propagation.ts
import type { Operation } from 'effection';
import { main, spawn, sleep } from 'effection';

await main(function*() {
  yield* spawn(function*(): Operation<void> {
    yield* sleep(100);
    throw new Error('Child failed!');
  });
  
  yield* spawn(function*(): Operation<void> {
    yield* sleep(1000);  // This will be halted!
    console.log('Never reached');
  });
  
  yield* sleep(2000);
  console.log('Also never reached');
});
```

The hierarchy after failure:

```
+-- main [FAILED]
    |
    +-- child 1 [FAILED] (threw error)
    |
    +-- child 2 [HALTED] (killed by parent)
```

When child 1 fails, it causes main to fail. Main then halts all remaining children before propagating the error.

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

## The Task Hierarchy Visualized

Understanding the hierarchy is key to understanding Effection:

```typescript
// hierarchy.ts
import type { Operation } from 'effection';
import { main, spawn, sleep, suspend } from 'effection';

await main(function*() {           // Level 0: main
  yield* spawn(function*(): Operation<void> {       // Level 1: child A
    yield* spawn(function*(): Operation<void> {     // Level 2: grandchild A1
      yield* suspend();
    });
    yield* spawn(function*(): Operation<void> {     // Level 2: grandchild A2
      yield* suspend();
    });
    yield* suspend();
  });
  
  yield* spawn(function*(): Operation<void> {       // Level 1: child B
    yield* suspend();
  });
  
  yield* sleep(100);
});
```

Hierarchy:
```
main
├── child A
│   ├── grandchild A1
│   └── grandchild A2
└── child B
```

If `main` ends:
- All of `main`'s children are halted
- Each child halts its own children (recursively)
- Cleanup happens in reverse order (deepest first)

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
