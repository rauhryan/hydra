/**
 * first-success-signals.ts
 *
 * The elegant solution using Signals!
 * Compare this to first-success-simple.ts - no polling needed.
 * Tasks can directly signal when they succeed.
 */
import type { Operation, Signal } from 'effection';
import { main, spawn, sleep, scoped, createSignal, each } from 'effection';

// Simulated weather services with different speeds and reliability
function* fetchWeather(service: string, delay: number, shouldFail: boolean): Operation<string> {
  console.log(`${service}: fetching...`);
  yield* sleep(delay);
  if (shouldFail) {
    console.log(`${service}: FAILED`);
    throw new Error(`${service} failed`);
  }
  console.log(`${service}: succeeded!`);
  return `Weather from ${service}: Sunny, 72°F`;
}

/**
 * Returns the first operation to succeed, ignoring failures.
 * Only fails if ALL operations fail.
 *
 * This is the elegant solution: instead of polling, we use a Signal
 * to coordinate between tasks. When any task succeeds, it sends the
 * result to the signal, and we immediately receive it.
 *
 * No polling. No wasted CPU. Just clean, event-driven coordination.
 */
function* firstSuccess<T>(operations: (() => Operation<T>)[]): Operation<T> {
  // A Signal lets us send values from spawned tasks back to the parent
  const success: Signal<T, never> = createSignal<T, never>();
  let failureCount = 0;
  const total = operations.length;

  return yield* scoped(function* () {
    for (const op of operations) {
      yield* spawn(function* () {
        try {
          const value = yield* op();
          success.send(value); // No yield* needed - it's synchronous!
        } catch {
          failureCount++;
          if (failureCount === total) {
            // All failed - we need to unblock the waiting consumer
            // We'll throw from the for loop below
          }
        }
      });
    }

    // Wait for the first success - this blocks until send() is called
    for (const result of yield* each(success)) {
      return result; // Got one! Exit immediately (scope halts other tasks)
    }

    // If we get here, signal was closed without any successes
    throw new Error('All operations failed');
  });
}

// Demo
await main(function* () {
  console.log('=== First Success (Signals Solution) ===\n');
  console.log('Racing 3 weather services:');
  console.log('  - service-a: 100ms, will FAIL');
  console.log('  - service-b: 200ms, will succeed');
  console.log('  - service-c: 300ms, will succeed');
  console.log('');

  try {
    const weather = yield* firstSuccess([
      () => fetchWeather('service-a', 100, true), // Fast but fails
      () => fetchWeather('service-b', 200, false), // Slower but succeeds
      () => fetchWeather('service-c', 300, false), // Slowest
    ]);

    console.log('');
    console.log('Result:', weather);
  } catch (error) {
    console.log('Error:', (error as Error).message);
  }

  console.log('');
  console.log('No polling! The Signal let us coordinate cleanly.');
  console.log('When service-b succeeded, it sent the result directly.');
  console.log("We didn't waste CPU checking variables in a loop.");
  console.log('');
  console.log('Learn more about Signals in Chapter 08!');
});
