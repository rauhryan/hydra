# Chapter 2.3: Resources - Long-Running Managed Services

Actions are great for one-time operations: do something, get a result, clean up. But what about things that need to **stay alive** while you interact with them?

- A WebSocket connection you send messages through
- An HTTP server that handles requests
- A database connection pool
- A file watcher

These are **resources** - long-running services that you need to interact with during their lifetime.

---

## The Problem: Operations That Block

We want to create a `useSocket()` function that:
1. Creates and connects a socket
2. Returns the socket to the caller for use
3. Cleans up the socket when the scope ends

Let's try building this with what we know so far:

```typescript
// blocking-socket.ts (THIS DOESN'T WORK!)
import type { Operation } from 'effection';
import { main, action, suspend } from 'effection';
import { EventEmitter } from 'events';

// Fake socket for demo
class FakeSocket extends EventEmitter {
  connect() { setTimeout(() => this.emit('connect'), 100); }
  send(msg: string) { console.log('Sending:', msg); }
  close() { console.log('Socket closed'); }
}

function* useSocket(): Operation<FakeSocket> {
  const socket = new FakeSocket();
  socket.connect();
  
  // Wait for connection
  yield* action<void>((resolve) => {
    socket.once('connect', resolve);
    return () => {};
  });
  
  try {
    yield* suspend();  // Stay alive for cleanup...
    return socket;     
  } finally {
    socket.close();
  }
}

await main(function*() {
  const socket = yield* useSocket();
  socket.send('hello');
});
```

**This code hangs forever!** Let's trace through it:

```
┌──────────────────────────────────────────────────────────────────┐
│ main()                                                           │
│                                                                  │
│   const socket = yield* useSocket();  <─── Waiting here...      │
│                          │                                       │
│                          v                                       │
│               ┌─────────────────────┐                            │
│               │ useSocket()         │                            │
│               │                     │                            │
│               │  1. connect()   ✓   │                            │
│               │  2. wait for it ✓   │                            │
│               │  3. suspend()   ⏸   │ <─── Stuck forever         │
│               │  4. return      ✗   │ <─── Never reached         │
│               └─────────────────────┘                            │
│                                                                  │
│   socket.send('hello');  <─── Never happens                      │
└──────────────────────────────────────────────────────────────────┘
```

The problem: `suspend()` keeps the operation alive (good for cleanup!) but blocks the return (bad for the caller!).

We can't win:
- **Return immediately?** The operation ends, `finally` runs, socket closes before we use it
- **Suspend to stay alive?** We never return the socket to the caller

We need a way to say: *"Here's the value — now keep me alive until you're done with it."*

---

## Enter `resource()`

The `resource()` function solves this with a special `provide()` operation:

```typescript
// resource-socket.ts
import type { Operation } from 'effection';
import { main, resource, action, sleep } from 'effection';
import { EventEmitter } from 'events';

// Fake socket for demo
class FakeSocket extends EventEmitter {
  connect() { setTimeout(() => this.emit('connect'), 100); }
  send(msg: string) { console.log('Sending:', msg); }
  close() { console.log('Socket closed'); }
}

function useSocket(): Operation<FakeSocket> {
  return resource<FakeSocket>(function*(provide) {
    const socket = new FakeSocket();
    socket.connect();
    
    // Wait for connection
    yield* action<void>((resolve) => {
      socket.once('connect', resolve);
      return () => {};
    });
    
    console.log('Socket connected!');
    
    try {
      // provide() gives the socket to the caller AND suspends
      yield* provide(socket);
    } finally {
      socket.close();
    }
  });
}

await main(function*() {
  const socket: FakeSocket = yield* useSocket();
  
  socket.send('hello');
  socket.send('world');
  
  yield* sleep(100);
  
  // When main ends, the resource cleans up
});
```

Output:
```
Socket connected!
Sending: hello
Sending: world
Socket closed
```

---

## How `provide()` Works

To understand why `provide()` is special, let's look at how `yield*` normally behaves.

When you write `yield*`, control flows INTO the operation and doesn't come back until it completes:

```
main()                            useSocket() 
  │                                  │
  │                                  │ function* useSocket() {
  │                                  │   try {
  │  yield* useSocket() ──────────────────>│  connect...
  │                                  │     │  wait...
  │     (waiting...)                 │     │  yield* suspend() ⏸
  │     (waiting forever)            │     │
  │                                  │     │  return socket  ✗ never reached
  │                                  │   } finally { cleanup }
  │                                  │ }
  v                                  v
```

That's why our first attempt hung — `yield* suspend()` never completes, so control never returns.

`yield* provide(socket)` breaks this pattern. The `yield*` sends the socket back to the caller, but the resource keeps running:

```
main()                            useSocket() 
  │                                  │
  │                                  │ function useSocket() {
  │                                  │   return resource(function*(provide) {
  │                                  │     │
  │  yield* useSocket() ──────────────────>│  connect...
  │                                  │     │  wait...
  │                                  │     │
  │  <───────── socket ───────────────────── yield* provide(socket)
  │                                  │     │
  │  socket.send('hello')            │     │  ⏸ (suspended, still alive)
  │  socket.send('world')            │     │
  │                                  │     │
  │  scope ends ───────────────────────────>  finally { cleanup }
  │                                  │   })
  │                                  │ }
  v                                  v
```

This is the key insight: **`yield* provide(value)` uses the yield to send a value back to the caller, while the resource keeps running in the background.** When the parent scope ends, the resource resumes from `provide()` and hits the `finally` block for cleanup.

---

## The Two Criteria for Resources

Use a resource when:

1. **The operation is long-running** - it needs to stay alive
2. **You need to interact with it** - call methods, send data, etc.

If you just need to do some async work and get a result, use a regular operation.
If you need to set up something and keep it running, use a resource.

---

## Resources Can Use Resources

Resources compose naturally:

```typescript
// composed-resources.ts
import type { Operation } from 'effection';
import { main, resource, spawn, sleep } from 'effection';
import { EventEmitter } from 'events';

// Fake socket
class FakeSocket extends EventEmitter {
  connect() { setTimeout(() => this.emit('connect'), 50); }
  send(msg: string) { console.log('>> Sending:', msg); }
  close() { console.log('Socket closed'); }
}

function useSocket(): Operation<FakeSocket> {
  return resource<FakeSocket>(function*(provide) {
    const socket = new FakeSocket();
    socket.connect();
    
    yield* sleep(50); // Wait for connect
    
    try {
      yield* provide(socket);
    } finally {
      socket.close();
    }
  });
}

// A socket with automatic heartbeat
function useHeartbeatSocket(): Operation<FakeSocket> {
  return resource<FakeSocket>(function*(provide) {
    // Use another resource!
    const socket: FakeSocket = yield* useSocket();
    
    // Start heartbeat in background
    yield* spawn(function*(): Operation<void> {
      while (true) {
        yield* sleep(500);
        socket.send('heartbeat');
      }
    });
    
    // Provide the socket
    yield* provide(socket);
    
    // Cleanup: when this resource ends, the spawned heartbeat
    // is automatically halted (child of this resource)
  });
}

await main(function*() {
  const socket: FakeSocket = yield* useHeartbeatSocket();
  
  socket.send('hello');
  
  yield* sleep(1200);  // Let some heartbeats happen
  
  socket.send('goodbye');
  
  // When main ends:
  // 1. useHeartbeatSocket's spawn is halted (heartbeat stops)
  // 2. useSocket's finally runs (socket.close())
});
```

Output:
```
>> Sending: hello
>> Sending: heartbeat
>> Sending: heartbeat
>> Sending: goodbye
Socket closed
```

---

## Practical Example: HTTP Server Resource

```typescript
// http-server-resource.ts
import type { Operation } from 'effection';
import { main, resource, ensure, suspend } from 'effection';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

interface HttpServer {
  server: Server;
  port: number;
}

function useHttpServer(port: number): Operation<HttpServer> {
  return resource<HttpServer>(function*(provide) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Hello from Effection!\n');
    });
    
    // Start listening
    server.listen(port);
    console.log(`Server starting on port ${port}...`);
    
    // Ensure cleanup
    yield* ensure(() => {
      console.log('Closing server...');
      server.close();
    });
    
    // Provide the server to the caller
    yield* provide({ server, port });
  });
}

await main(function*() {
  const { port }: HttpServer = yield* useHttpServer(3000);
  
  console.log(`Server running at http://localhost:${port}`);
  console.log('Press Ctrl+C to stop\n');
  
  // Keep running until interrupted
  yield* suspend();
});
```

Run it and press Ctrl+C - you'll see "Closing server..." printed, proving cleanup ran!

---

## Using `ensure()` for Cleanup

Instead of try/finally, you can use `ensure()`:

```typescript
// ensure-example.ts
import type { Operation } from 'effection';
import { main, resource, ensure, sleep } from 'effection';

interface Connection {
  query: (sql: string) => string;
}

function useDatabase(): Operation<Connection> {
  return resource<Connection>(function*(provide) {
    console.log('Connecting to database...');
    yield* sleep(100); // Simulate connection time
    
    const connection: Connection = {
      query: (sql: string) => `Result of: ${sql}`,
    };
    
    // ensure() is cleaner than try/finally for simple cleanup
    yield* ensure(() => {
      console.log('Disconnecting from database...');
    });
    
    console.log('Database connected!');
    yield* provide(connection);
  });
}

await main(function*() {
  const db: Connection = yield* useDatabase();
  
  console.log(db.query('SELECT * FROM users'));
  
  yield* sleep(100);
  
  // cleanup runs when main ends
});
```

Output:
```
Connecting to database...
Database connected!
Result of: SELECT * FROM users
Disconnecting from database...
```

---

## Resources vs Actions vs Operations

| Use Case | Tool |
|----------|------|
| One-time callback (setTimeout) | `action()` |
| Async computation | Regular `function*` |
| Long-running service with interaction | `resource()` |
| Running concurrent child tasks | `spawn()` |

---

## Mini-Exercise: File Watcher Resource

Create `file-watcher.ts`:

```typescript
// file-watcher.ts
import type { Operation } from 'effection';
import { main, resource, spawn, sleep, createChannel, each } from 'effection';
import type { Channel } from 'effection';

// Simulated file system events
interface FileEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
}

interface FileWatcher {
  events: Channel<FileEvent, void>;
}

function useFileWatcher(directory: string): Operation<FileWatcher> {
  return resource<FileWatcher>(function*(provide) {
    console.log(`Starting file watcher on ${directory}`);
    
    const events = createChannel<FileEvent, void>();
    
    // Simulate file system events
    yield* spawn(function*(): Operation<void> {
      const fakeEvents: FileEvent[] = [
        { type: 'create', path: `${directory}/file1.txt` },
        { type: 'modify', path: `${directory}/file2.txt` },
        { type: 'delete', path: `${directory}/file3.txt` },
      ];
      
      for (const event of fakeEvents) {
        yield* sleep(300);
        yield* events.send(event);
      }
    });
    
    try {
      yield* provide({ events });
    } finally {
      console.log('File watcher stopped');
    }
  });
}

await main(function*() {
  const watcher: FileWatcher = yield* useFileWatcher('./src');
  
  // Process events for 2 seconds
  yield* spawn(function*(): Operation<void> {
    yield* sleep(2000);
  });
  
  for (const event of yield* each(watcher.events)) {
    console.log(`[${event.type.toUpperCase()}] ${event.path}`);
    yield* each.next();
  }
});
```

---

## Key Takeaways

1. **Resources are for long-running services** - things that need to stay alive
2. **`provide()` returns value AND suspends** - caller gets the value, resource stays alive
3. **Cleanup is guaranteed** - finally block runs when parent scope ends
4. **Resources compose** - resources can use other resources
5. **Use `ensure()` for simple cleanup** - cleaner than try/finally for one-liners

---

## Next Up

Resources can produce values via `provide()`, but what about ongoing streams of data? In Part 3, we'll learn about [Channels and Streams](./07-channels-streams.md) for pub/sub communication.
