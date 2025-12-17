/**
 * spinner-resource.ts
 *
 * An Effection-style spinner resource that self-animates using interval().
 *
 * Demonstrates:
 * - resource() for lifecycle management
 * - spawn() for background tasks
 * - interval() + each() for time-driven animation
 * - ensure() for guaranteed cleanup
 * - Task.halt() to stop spawned operations
 *
 * The spinner is:
 * - Event-triggered: call start() to begin, stop() to end
 * - Time-driven: animates at 80ms intervals (12.5fps)
 * - Idempotent: calling start() multiple times is safe
 * - Self-cleaning: automatically clears on scope exit
 */
import type { Operation, Task } from 'effection';
import { main, resource, spawn, each, interval, ensure, sleep } from 'effection';

// --- Spinner Resource ---

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  /** Start the spinner animation. Idempotent - safe to call multiple times. */
  start: (label?: string) => Operation<void>;
  /** Stop the spinner and clear the line. */
  stop: () => Operation<void>;
}

/**
 * Create a spinner resource that self-animates using interval().
 *
 * - start() spawns a background task that animates at 80ms intervals
 * - stop() halts the animation and clears the line
 * - Automatically cleans up on scope exit via ensure()
 *
 * @example
 * ```ts
 * const spinner = yield* useSpinner();
 * yield* spinner.start('loading');
 * yield* someAsyncWork();
 * yield* spinner.stop();
 * ```
 */
export function useSpinner(): Operation<Spinner> {
  return resource(function* (provide) {
    let animationTask: Task<void> | undefined;

    // Cleanup on scope exit (error, halt, or normal exit)
    yield* ensure(function* () {
      if (animationTask) {
        yield* animationTask.halt();
        process.stdout.write('\r' + ' '.repeat(20) + '\r');
      }
    });

    yield* provide({
      *start(label = 'thinking') {
        // Idempotent - if already running, do nothing
        if (animationTask) return;

        let frameIndex = 0;
        animationTask = yield* spawn(function* () {
          for (const _ of yield* each(interval(80))) {
            const frame = SPINNER_FRAMES[frameIndex++ % SPINNER_FRAMES.length];
            process.stdout.write(`\r${frame} ${label}...`);
            yield* each.next();
          }
        });
      },
      *stop() {
        if (animationTask) {
          yield* animationTask.halt();
          process.stdout.write('\r' + ' '.repeat(20) + '\r');
          animationTask = undefined;
        }
      },
    });
  });
}

/**
 * Run an operation with a spinner that animates for its duration.
 * Spinner automatically stops when operation completes or fails.
 *
 * @example
 * ```ts
 * const result = yield* withSpinner('fetching', fetchData());
 * ```
 */
export function* withSpinner<T>(label: string, op: Operation<T>): Operation<T> {
  const spinner = yield* useSpinner();
  yield* spinner.start(label);
  try {
    return yield* op;
  } finally {
    yield* spinner.stop();
  }
}

// --- Demo ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(function* () {
    console.log('Effection Spinner Resource Demo\n');

    // Demo 1: Manual start/stop
    console.log('1. Manual start/stop:');
    const spinner = yield* useSpinner();

    yield* spinner.start('loading');
    yield* sleep(1500);
    yield* spinner.stop();
    console.log('   Done loading!\n');

    // Demo 2: Multiple labels
    console.log('2. Different labels:');
    yield* spinner.start('connecting');
    yield* sleep(800);
    yield* spinner.stop();

    yield* spinner.start('authenticating');
    yield* sleep(600);
    yield* spinner.stop();

    yield* spinner.start('fetching data');
    yield* sleep(1000);
    yield* spinner.stop();
    console.log('   All steps complete!\n');

    // Demo 3: withSpinner convenience wrapper
    console.log('3. Using withSpinner():');
    const result = yield* withSpinner('processing', (function* () {
      yield* sleep(1200);
      return 42;
    })());
    console.log(`   Result: ${result}\n`);

    // Demo 4: Automatic cleanup on error
    console.log('4. Automatic cleanup (simulated error):');
    try {
      yield* withSpinner('risky operation', (function* () {
        yield* sleep(500);
        throw new Error('Something went wrong!');
      })());
    } catch (e) {
      console.log(`   Caught: ${(e as Error).message}`);
      console.log('   (Spinner was automatically cleaned up)\n');
    }

    console.log('Demo complete!');
  });
}
