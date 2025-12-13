/**
 * first-success-simple.ts
 *
 * A "good enough" solution for getting the first successful result.
 * This works, but feels clunky - we're polling! There must be a better way...
 * (Spoiler: there is. See first-success-signals.ts)
 */
import type { Operation } from 'effection';
import { main, spawn, sleep, scoped } from 'effection';

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
 * This works, but look at that polling loop! We're burning CPU cycles
 * checking a variable every 10ms. There has to be a better way to
 * coordinate between concurrent tasks...
 */
function* firstSuccess<T>(operations: (() => Operation<T>)[]): Operation<T> {
  let result: T | undefined;
  let succeeded = false;
  let failureCount = 0;
  const total = operations.length;

  yield* scoped(function* () {
    for (const op of operations) {
      yield* spawn(function* () {
        try {
          const value = yield* op();
          if (!succeeded) {
            succeeded = true;
            result = value;
          }
        } catch {
          failureCount++;
          // If all failed, we need to signal somehow...
          // but we can't throw here, it would kill the scope!
        }
      });
    }

    // UGLY: Poll until we get a success or all fail
    // This is the best we can do without better coordination primitives
    while (!succeeded && failureCount < total) {
      yield* sleep(10); // Waste CPU checking a variable...
    }

    if (!succeeded) {
      throw new Error('All operations failed');
    }
  });

  return result!;
}

// Demo
await main(function* () {
  console.log('=== First Success (Polling Solution) ===\n');
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
  console.log('It works! But did you see that polling loop?');
  console.log("We're checking a variable every 10ms. Gross.");
  console.log('');
  console.log('There must be a cleaner way to coordinate between tasks...');
  console.log('(Hint: See first-success-signals.ts for the elegant solution)');
});
