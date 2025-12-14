/**
 * generic-stream-function.ts
 *
 * Demonstrates writing functions that accept any Stream type.
 * This shows the power of Stream as a unifying abstraction.
 */
import type { Operation, Stream } from 'effection';
import {
  main,
  createChannel,
  createSignal,
  interval,
  spawn,
  sleep,
  each,
} from 'effection';

/**
 * A generic function that logs all values from ANY Stream.
 * Works with Channels, Signals, interval(), or custom streams.
 */
function* logAll<T>(label: string, stream: Stream<T, unknown>): Operation<void> {
  for (const value of yield* each(stream)) {
    console.log(`[${label}] Value:`, value);
    yield* each.next();
  }
}

/**
 * Takes the first N values from any Stream.
 */
function* take<T>(n: number, stream: Stream<T, unknown>): Operation<T[]> {
  const results: T[] = [];

  for (const value of yield* each(stream)) {
    results.push(value);
    if (results.length >= n) {
      break;
    }
    yield* each.next();
  }

  return results;
}

await main(function* () {
  console.log('=== Generic Stream Functions ===\n');

  // Create different types of streams
  const channel = createChannel<string, void>();
  const signal = createSignal<number, void>();

  // Use logAll with a Channel
  yield* spawn(function* () {
    yield* logAll('channel', channel);
  });

  // Use logAll with a Signal
  yield* spawn(function* () {
    yield* logAll('signal', signal);
  });

  // Use take() with interval
  yield* spawn(function* () {
    console.log('Taking 3 values from interval(500)...');
    const values = yield* take(3, interval(500));
    console.log('[interval] Got values:', values);
  });

  yield* sleep(10);

  // Send some values
  yield* channel.send('Hello');
  yield* channel.send('World');
  signal.send(42);
  signal.send(100);

  // Wait for interval to complete
  yield* sleep(2000);

  // Close streams
  channel.close();
  signal.close();

  console.log('\nDone!');
});
