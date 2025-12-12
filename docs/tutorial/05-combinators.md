# Chapter 2.2: The all() and race() Combinators

Spawning tasks manually and waiting for them is fine, but there are patterns so common that Effection provides built-in combinators. These are safer and cleaner alternatives to `Promise.all()` and `Promise.race()`.

---

## The Problem with Promise.all()

```typescript
// promise-all-problem.ts
async function fetchData(id: number): Promise<string> {
  await new Promise(r => setTimeout(r, id * 100));
  if (id === 2) throw new Error('Fetch failed!');
  return `Data ${id}`;
}

async function main(): Promise<void> {
  try {
    // If id=2 fails, what happens to id=1 and id=3?
    const results = await Promise.all([
      fetchData(1),
      fetchData(2),  // This throws!
      fetchData(3),
    ]);
    console.log(results);
  } catch (error) {
    console.log('Caught:', error);
    // id=1 and id=3 are still running in the background!
  }
}

main();
```

When one promise fails, `Promise.all()` rejects immediately - but the other promises keep running! They're dangling.

---

## Effection's `all()` Combinator

```typescript
// effection-all.ts
import type { Operation } from 'effection';
import { main, all, sleep } from 'effection';

function* fetchData(id: number): Operation<string> {
  console.log(`Starting fetch ${id}`);
  yield* sleep(id * 100);
  console.log(`Completed fetch ${id}`);
  return `Data ${id}`;
}

await main(function*() {
  const results: string[] = yield* all([
    fetchData(1),
    fetchData(2),
    fetchData(3),
  ]);
  
  console.log(results); // ['Data 1', 'Data 2', 'Data 3']
});
```

Output:
```
Starting fetch 1
Starting fetch 2
Starting fetch 3
Completed fetch 1
Completed fetch 2
Completed fetch 3
['Data 1', 'Data 2', 'Data 3']
```

`all()` waits for **all operations to complete** and returns an array of results in order.

---

## all() with Error Handling

When one operation fails, `all()` halts the others:

```typescript
// all-with-error.ts
import type { Operation } from 'effection';
import { main, all, sleep } from 'effection';

function* fetchData(id: number): Operation<string> {
  console.log(`Starting fetch ${id}`);
  yield* sleep(id * 100);
  if (id === 2) {
    console.log(`Fetch ${id} FAILED`);
    throw new Error('Fetch 2 failed!');
  }
  console.log(`Completed fetch ${id}`);
  return `Data ${id}`;
}

await main(function*() {
  try {
    const results: string[] = yield* all([
      fetchData(1),
      fetchData(2),  // This throws after 200ms
      fetchData(3),  // This gets halted!
    ]);
    console.log(results);
  } catch (error) {
    console.log('Caught:', (error as Error).message);
  }
});
```

Output:
```
Starting fetch 1
Starting fetch 2
Starting fetch 3
Completed fetch 1
Fetch 2 FAILED
Caught: Fetch 2 failed!
```

Notice that `Completed fetch 3` never prints - it was halted when fetch 2 failed.

---

## The Problem with Promise.race()

We covered this in Chapter 1, but here's a reminder:

```typescript
// promise-race-problem.ts
async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.time('total');
  await Promise.race([
    sleep(10),
    sleep(1000),
  ]);
  console.timeEnd('total');
  // Process won't exit for 1000ms because the second timer is still running!
}

main();
```

---

## Effection's `race()` Combinator

```typescript
// effection-race.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

await main(function*() {
  console.time('total');
  
  yield* race([
    sleep(10),
    sleep(1000),
  ]);
  
  console.timeEnd('total'); // ~10ms, and process exits immediately!
});
```

When one operation wins, `race()` **halts all the losers**. No leaked effects!

---

## race() with Return Values

`race()` returns the value of the winning operation:

```typescript
// race-return-value.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

function* fetchFromAPI(name: string, delay: number): Operation<string> {
  console.log(`${name}: starting (${delay}ms)`);
  yield* sleep(delay);
  console.log(`${name}: completed`);
  return `Response from ${name}`;
}

await main(function*() {
  const winner: string = yield* race([
    fetchFromAPI('fast-api', 100),
    fetchFromAPI('slow-api', 500),
  ]);
  
  console.log('Winner:', winner);
});
```

Output:
```
fast-api: starting (100ms)
slow-api: starting (500ms)
fast-api: completed
Winner: Response from fast-api
```

Notice `slow-api: completed` never prints - it was halted.

---

## Practical Example: Timeout Pattern

A common pattern is racing an operation against a timeout:

```typescript
// timeout-pattern.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function* timeout<T>(ms: number): Operation<T> {
  yield* sleep(ms);
  throw new TimeoutError(ms);
}

function* withTimeout<T>(operation: Operation<T>, ms: number): Operation<T> {
  return yield* race([
    operation,
    timeout<T>(ms),
  ]);
}

// Simulated slow API
function* slowFetch(): Operation<string> {
  yield* sleep(5000);
  return 'data';
}

await main(function*() {
  try {
    const result: string = yield* withTimeout(slowFetch(), 1000);
    console.log('Result:', result);
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.log('Request timed out!');
    } else {
      throw error;
    }
  }
});
```

Output:
```
Request timed out!
```

The slow fetch is automatically halted when the timeout fires.

---

## Practical Example: First Successful Response

Sometimes you want to query multiple services and use the first one that succeeds:

```typescript
// first-success.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

function* fetchWeather(service: string, delay: number, shouldFail: boolean): Operation<string> {
  console.log(`${service}: fetching...`);
  yield* sleep(delay);
  if (shouldFail) {
    throw new Error(`${service} failed`);
  }
  return `Weather from ${service}: Sunny, 72°F`;
}

await main(function*() {
  try {
    const weather: string = yield* race([
      fetchWeather('service-a', 100, true),   // Fast but fails
      fetchWeather('service-b', 200, false),  // Slower but succeeds
      fetchWeather('service-c', 300, false),  // Slowest
    ]);
    
    console.log(weather);
  } catch (error) {
    console.log('All services failed');
  }
});
```

Wait - this doesn't quite work! If service-a fails first, the whole race fails. What we really want is "first to **succeed**". We'd need a custom combinator for that (which we'll build later with streams).

---

## Combining all() and spawn()

For complex orchestration, combine these tools:

```typescript
// complex-orchestration.ts
import type { Operation, Task } from 'effection';
import { main, spawn, all, sleep } from 'effection';

interface User { id: number; name: string; }
interface Post { id: number; title: string; userId: number; }
interface Comment { id: number; text: string; postId: number; }

function* fetchUser(id: number): Operation<User> {
  yield* sleep(100);
  return { id, name: `User ${id}` };
}

function* fetchPosts(userId: number): Operation<Post[]> {
  yield* sleep(150);
  return [
    { id: 1, title: 'First Post', userId },
    { id: 2, title: 'Second Post', userId },
  ];
}

function* fetchComments(postId: number): Operation<Comment[]> {
  yield* sleep(50);
  return [
    { id: 1, text: 'Great!', postId },
    { id: 2, text: 'Thanks!', postId },
  ];
}

await main(function*() {
  console.time('total');
  
  // Fetch user first
  const user: User = yield* fetchUser(1);
  
  // Fetch all posts
  const posts: Post[] = yield* fetchPosts(user.id);
  
  // Fetch comments for all posts in parallel!
  const allComments: Comment[][] = yield* all(
    posts.map(post => fetchComments(post.id))
  );
  
  console.log({
    user,
    posts,
    comments: allComments.flat(),
  });
  
  console.timeEnd('total'); // ~300ms total
});
```

---

## Mini-Exercise: API Fallback

Create `api-fallback.ts` that tries multiple APIs with a timeout:

```typescript
// api-fallback.ts
import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

// Simulated APIs with different speeds/reliability
function* fetchFromPrimary(): Operation<string> {
  console.log('Trying primary API...');
  yield* sleep(2000); // Slow today!
  return 'Data from primary';
}

function* fetchFromBackup(): Operation<string> {
  console.log('Trying backup API...');
  yield* sleep(500);
  return 'Data from backup';
}

function* timeout(ms: number): Operation<never> {
  yield* sleep(ms);
  throw new Error(`Timeout after ${ms}ms`);
}

await main(function*() {
  console.log('Fetching data with 1s timeout per API...\n');
  
  // Try primary first with timeout
  let data: string;
  
  try {
    data = yield* race([
      fetchFromPrimary(),
      timeout(1000),
    ]);
    console.log('Got data from primary!');
  } catch (error) {
    console.log('Primary timed out, trying backup...\n');
    
    data = yield* race([
      fetchFromBackup(),
      timeout(1000),
    ]);
    console.log('Got data from backup!');
  }
  
  console.log('\nResult:', data);
});
```

Run it: `npx tsx api-fallback.ts`

---

## Key Takeaways

1. **`all()` is like `Promise.all()`** - but halts remaining operations on failure
2. **`race()` is like `Promise.race()`** - but halts losers, no leaked effects
3. **Combine with `spawn()`** for complex orchestration
4. **Use `race()` for timeouts** - race your operation against a timer
5. **No dangling operations** - structured concurrency guarantees cleanup

---

## Next Up

We've seen how to run operations concurrently and wait for them. But what about long-running services that need to stay alive while you interact with them? That's where [Resources](./06-resources.md) come in.
