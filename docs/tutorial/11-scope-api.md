# Chapter 4.1: Scope API - Embedding Effection

Effection works beautifully when you're inside the operation tree. But real apps need to integrate with:

- Express/Fastify route handlers
- React component lifecycles  
- Callback-based libraries
- Test frameworks

The **Scope API** lets you run Effection operations from regular JavaScript code.

---

## The Problem: Callbacks Can't Yield

Express route handlers are regular async functions:

```typescript
// broken-express.ts
import express from 'express';
import { main, sleep } from 'effection';

const app = express();

app.get('/slow', async (req, res) => {
  // How do we use Effection here?
  yield* sleep(1000);  // SyntaxError! Not a generator
  res.send('Done');
});
```

We need a way to run operations from inside callback functions.

---

## `useScope()` - Capture the Current Scope

The `useScope()` operation gives you a reference to the current scope that you can use later:

```typescript
// use-scope-basic.ts
import type { Operation, Scope } from 'effection';
import { main, useScope, sleep, suspend } from 'effection';

await main(function*() {
  // Capture the current scope
  const scope: Scope = yield* useScope();
  
  // Now we can use scope.run() from any callback!
  setTimeout(async () => {
    await scope.run(function*(): Operation<void> {
      console.log('Running in callback!');
      yield* sleep(100);
      console.log('Done!');
    });
  }, 50);
  
  yield* sleep(200);
});
```

Output:
```
Running in callback!
Done!
```

---

## Express Integration

Here's the pattern for Express:

```typescript
// express-integration.ts
import type { Operation, Scope } from 'effection';
import { main, useScope, sleep, ensure, suspend } from 'effection';
import express, { Request, Response } from 'express';

await main(function*() {
  // Capture scope for use in route handlers
  const scope: Scope = yield* useScope();
  
  const app = express();
  
  // Route handler uses scope.run()
  app.get('/api/data', async (req: Request, res: Response) => {
    try {
      const result = await scope.run(function*(): Operation<string> {
        console.log('Handling request...');
        yield* sleep(100);  // Simulate async work
        return 'Hello from Effection!';
      });
      res.json({ data: result });
    } catch (error) {
      res.status(500).json({ error: 'Internal error' });
    }
  });
  
  // Slow endpoint that can be cancelled
  app.get('/api/slow', async (req: Request, res: Response) => {
    try {
      await scope.run(function*(): Operation<void> {
        yield* sleep(5000);
        res.json({ data: 'Finally done!' });
      });
    } catch (error) {
      // If the operation was halted, we'll end up here
      if (!res.headersSent) {
        res.status(503).json({ error: 'Request cancelled' });
      }
    }
  });
  
  const server = app.listen(3000);
  console.log('Server running on http://localhost:3000');
  
  yield* ensure(() => {
    console.log('Shutting down server...');
    server.close();
  });
  
  yield* suspend();
});
```

---

## Why `scope.run()` is Better than `run()`

When you use `scope.run()`:

1. **Operations are children of the scope** - they get halted when the scope ends
2. **Context is inherited** - operations can access parent context values
3. **Errors propagate properly** - child failures can crash the parent

When you use top-level `run()`:

1. **Operations are independent** - they keep running even if they shouldn't
2. **No context inheritance** - can't access parent context
3. **Errors are isolated** - dangling operations possible

---

## Request-Scoped Operations

Each request can have its own scope:

```typescript
// request-scoped.ts
import type { Operation, Scope, Context } from 'effection';
import { main, useScope, createContext, spawn, sleep, ensure, suspend } from 'effection';
import express, { Request, Response } from 'express';

interface RequestInfo {
  id: string;
  startTime: number;
}

const RequestContext: Context<RequestInfo> = createContext<RequestInfo>('request');

let requestCounter = 0;

await main(function*() {
  const scope: Scope = yield* useScope();
  const app = express();
  
  app.get('/api/user/:id', async (req: Request, res: Response) => {
    const requestId = `req-${++requestCounter}`;
    
    await scope.run(function*(): Operation<void> {
      // Set request-specific context
      yield* RequestContext.set({
        id: requestId,
        startTime: Date.now(),
      });
      
      // Now any operation can access request info
      const user = yield* fetchUser(parseInt(req.params.id));
      
      const reqInfo: RequestInfo = yield* RequestContext.expect();
      const duration = Date.now() - reqInfo.startTime;
      
      console.log(`[${reqInfo.id}] Completed in ${duration}ms`);
      
      res.json(user);
    });
  });
  
  const server = app.listen(3000);
  console.log('Server running on http://localhost:3000');
  
  yield* ensure(() => server.close());
  yield* suspend();
});

function* fetchUser(id: number): Operation<{ id: number; name: string }> {
  const req: RequestInfo = yield* RequestContext.expect();
  console.log(`[${req.id}] Fetching user ${id}...`);
  
  yield* sleep(100);
  
  return { id, name: `User ${id}` };
}
```

---

## `createScope()` - Independent Scopes

Sometimes you need a completely independent scope (e.g., for testing):

```typescript
// create-scope.ts
import type { Operation, Scope } from 'effection';
import { createScope, sleep } from 'effection';

async function runTest(): Promise<void> {
  // Create a fresh, independent scope
  const [scope, destroy]: [Scope, () => Promise<void>] = createScope();
  
  try {
    // Run operations in this scope
    const result = await scope.run(function*(): Operation<string> {
      yield* sleep(100);
      return 'test passed';
    });
    
    console.log(result);
  } finally {
    // IMPORTANT: Always destroy the scope when done!
    await destroy();
  }
}

runTest();
```

---

## Testing with Scopes

Perfect for test frameworks:

```typescript
// testing-example.ts
import type { Operation, Scope } from 'effection';
import { createScope, sleep } from 'effection';

// Example using a test framework pattern
describe('MyService', () => {
  let scope: Scope;
  let destroy: () => Promise<void>;
  
  beforeEach(() => {
    [scope, destroy] = createScope();
  });
  
  afterEach(async () => {
    await destroy();
  });
  
  it('should do something async', async () => {
    const result = await scope.run(function*(): Operation<number> {
      yield* sleep(10);
      return 42;
    });
    
    expect(result).toBe(42);
  });
  
  it('handles cancellation', async () => {
    const task = scope.run(function*(): Operation<void> {
      yield* sleep(10000);  // Long operation
    });
    
    // Cancel it
    await destroy();
    
    // Task was halted, not left dangling
  });
});

// Stub for the example
function describe(name: string, fn: () => void) { fn(); }
function beforeEach(fn: () => void) { fn(); }
function afterEach(fn: () => void) {}
function it(name: string, fn: () => Promise<void>) { fn(); }
function expect(v: unknown) { return { toBe: () => {} }; }
```

---

## `useAbortSignal()` - Integration with fetch

Many APIs accept an `AbortSignal` for cancellation:

```typescript
// abort-signal.ts
import type { Operation } from 'effection';
import { main, useAbortSignal, race, sleep } from 'effection';

function* fetchWithEffection(url: string): Operation<Response> {
  // Get an AbortSignal tied to this operation's lifetime
  const signal: AbortSignal = yield* useAbortSignal();
  
  // Pass it to fetch - request will be cancelled if operation halts!
  const response = yield* Promise.resolve(fetch(url, { signal }));
  
  return response;
}

await main(function*() {
  try {
    // Race fetch against timeout
    const response: Response = yield* race([
      fetchWithEffection('https://httpbin.org/delay/10'),  // 10 second delay
      timeout(2000),  // 2 second timeout
    ]);
    
    console.log('Got response:', response.status);
  } catch (error) {
    console.log('Request timed out or failed');
  }
});

function* timeout(ms: number): Operation<never> {
  yield* sleep(ms);
  throw new Error(`Timeout after ${ms}ms`);
}
```

When the timeout wins, the fetch operation is halted, and the `AbortSignal` fires, actually cancelling the HTTP request!

---

## Pattern: Scope Provider Resource

Create a resource that provides a scope for request handling:

```typescript
// scope-provider.ts
import type { Operation, Scope } from 'effection';
import { main, resource, useScope, sleep, suspend } from 'effection';
import express, { Express, Request, Response } from 'express';
import { Server } from 'http';

interface ExpressApp {
  app: Express;
  scope: Scope;
  port: number;
}

function useExpressApp(port: number): Operation<ExpressApp> {
  return resource<ExpressApp>(function*(provide) {
    const scope: Scope = yield* useScope();
    const app = express();
    
    const server: Server = app.listen(port);
    console.log(`Express listening on port ${port}`);
    
    try {
      yield* provide({ app, scope, port });
    } finally {
      console.log('Closing Express server...');
      server.close();
    }
  });
}

await main(function*() {
  const { app, scope, port }: ExpressApp = yield* useExpressApp(3000);
  
  app.get('/', async (req: Request, res: Response) => {
    await scope.run(function*(): Operation<void> {
      yield* sleep(100);
      res.send('Hello from Effection!');
    });
  });
  
  console.log(`Server ready at http://localhost:${port}`);
  yield* suspend();
});
```

---

## Key Takeaways

1. **`useScope()` captures the current scope** - for later use in callbacks
2. **`scope.run()` runs operations as children** - proper lifecycle management
3. **`createScope()` creates independent scopes** - perfect for testing
4. **Always destroy created scopes** - prevent memory leaks
5. **`useAbortSignal()` integrates with fetch** - true cancellation

---

## Next Up

Let's put it all together and start building our [Capstone: Multiplex HTTP Proxy](./12-capstone-architecture.md)!
