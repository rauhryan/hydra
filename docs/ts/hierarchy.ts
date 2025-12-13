// hierarchy.ts - Understanding scope lifetime and task execution
//
// This example demonstrates 4 key behaviors that can trip you up:
// 1. Parent must yield for children to run
// 2. Spawn is lazy - child starts when parent yields
// 3. Cleanup happens deepest-first
// 4. Scope lifetime determines child lifetime

import type { Operation } from 'effection';
import { main, spawn, sleep, ensure, scoped } from 'effection';

await main(function*() {
  // ═══════════════════════════════════════════════════════════════════
  // Scenario 1: Parent must yield for children to run
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 1: Parent must yield for children to run ═══\n');

  yield* spawn(function*() {
    console.log('[parent] Starting');

    // Spawn a grandchild...
    yield* spawn(function*() {
      console.log('[grandchild] Running!'); // Will this print?
      yield* sleep(100);
      console.log('[grandchild] Done!');
    });

    // ...but return immediately without yielding!
    console.log('[parent] Returning immediately');
    return;
    // Parent scope ends, grandchild never gets a chance to run!
  });

  yield* sleep(200);
  console.log('Result: Grandchild never ran because parent returned immediately!\n');

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 2: Spawn is lazy - child starts when parent yields
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 2: Spawn is lazy ═══\n');

  yield* spawn(function*() {
    console.log('[1] Before spawn');

    yield* spawn(function*() {
      yield* ensure(() => console.log('[child] Exiting (halted!)'));
      console.log('[3] Child started');
      yield* sleep(50);
      console.log('[child] Finished'); // Never prints!
    });

    console.log('[2] After spawn, before yield');
    yield* sleep(0); // Yield control - NOW child runs
    console.log('[4] After yield');

    yield* sleep(0);
    console.log('[5] Parent exiting');
  });

  yield* sleep(200);
  console.log(`
Timeline:
  [1] → [2] → yield → [3] → child sleeps...
                        ↓
               [4] → [5] → parent exits
                        ↓
               child halted! (never prints "Finished")

Result: Child started AFTER parent yielded, but was halted when parent exited!
`);

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 3: Cleanup happens deepest-first
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 3: Cleanup order (deepest first) ═══\n');

  yield* scoped(function*() {
    yield* ensure(() => console.log('[grandparent] Cleanup (last)'));

    yield* spawn(function*() {
      yield* ensure(() => console.log('[parent] Cleanup (second)'));

      yield* spawn(function*() {
        yield* ensure(() => console.log('[child] Cleanup (first)'));
        yield* sleep(1000); // Will be halted
      });

      yield* sleep(1000); // Will be halted
    });

    yield* sleep(50); // Let tasks start, then scope ends
  });

  console.log('Result: Cleanup ran child → parent → grandparent!\n');

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 4: Scope lifetime determines child lifetime
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ Scenario 4: Scope lifetime limits children ═══\n');

  yield* scoped(function*() {
    yield* spawn(function*() {
      let tick = 0;
      while (true) {
        console.log(`[ticker] tick ${++tick}`);
        yield* sleep(100);
      }
    });

    yield* sleep(350); // Scope lives for ~3 ticks
    console.log('[scope] Ending...');
  });

  console.log('[main] Scope ended - ticker is gone!\n');
  yield* sleep(200); // Prove ticker isn't running anymore

  console.log('═══ All scenarios complete ═══');
});
