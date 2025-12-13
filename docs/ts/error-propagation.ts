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
