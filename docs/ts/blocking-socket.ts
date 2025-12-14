/**
 * blocking-socket.ts
 *
 * ⚠️  THIS EXAMPLE INTENTIONALLY DEMONSTRATES A PROBLEM
 *
 * It shows what happens when you try to use suspend() to keep
 * a socket alive for cleanup. Spoiler: it blocks forever!
 *
 * Run `npx tsx resource-socket.ts` to see the correct solution.
 */
import type { Operation } from 'effection';
import { main, action, suspend, race, sleep } from 'effection';
import { EventEmitter } from 'events';

// Fake socket for demo
class FakeSocket extends EventEmitter {
  connect() {
    setTimeout(() => this.emit('connect'), 100);
  }
  send(msg: string) {
    console.log('Sending:', msg);
  }
  close() {
    console.log('Socket closed');
  }
}

function* useSocket(): Operation<FakeSocket> {
  const socket = new FakeSocket();
  socket.connect();

  // Wait for connection
  yield* action<void>((resolve) => {
    socket.once('connect', resolve);
    return () => {};
  });

  console.log('  Socket connected!');

  try {
    // We want to return the socket... but also clean up later
    // So we suspend() to keep the operation alive...
    console.log('  Calling suspend()...');
    yield* suspend(); // This blocks forever!
    return socket; // We never get here!
  } finally {
    socket.close();
  }
}

// Helper to timeout after a delay
function* timeout(ms: number): Operation<never> {
  yield* sleep(ms);
  throw new Error(`Timed out after ${ms}ms`);
}

await main(function* () {
  console.log('=== The Problem: Operations That Block ===\n');
  console.log('We want to create a socket, return it to the caller,');
  console.log('and clean it up when the scope ends.\n');
  console.log("Let's try using suspend() to keep the operation alive...\n");

  console.log('Calling: const socket = yield* useSocket()');

  try {
    // Race against a timeout so we don't actually hang forever
    const socket = yield* race([useSocket(), timeout(2000)]);

    // This line is never reached!
    socket.send('hello');
  } catch (error) {
    console.log('');
    console.log('─'.repeat(50));
    console.log('');
    console.log('Problem: suspend() blocks forever!');
    console.log('');
    console.log('The socket connected, but then suspend() blocked.');
    console.log('We never got to `return socket` - the caller is stuck.');
    console.log('');
    console.log('We need a way to:');
    console.log('  1. Return the socket to the caller');
    console.log('  2. Keep the operation alive for cleanup');
    console.log('');
    console.log('Solution: resource() with provide()');
    console.log('');
    console.log('Run: npx tsx resource-socket.ts');
  }
});
