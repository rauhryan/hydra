// wrong-way.ts - Why run() inside operations breaks structured concurrency
import type { Operation } from 'effection';
import { main, run, spawn, sleep, ensure, scoped } from 'effection';

function* task(name: string): Operation<string> {
  console.log(`[${name}] Started`);
  yield* ensure(() => console.log(`[${name}] Cleanup`));
  yield* sleep(500);
  console.log(`[${name}] Done`);
  return name;
}

await main(function*() {
  // === CORRECT: spawn() creates children that get cleaned up ===
  console.log('=== spawn(): Structured Concurrency ===\n');

  yield* scoped(function*() {
    yield* spawn(() => task('child-a'));
    yield* spawn(() => task('child-b'));

    yield* sleep(100);
    console.log('Scope exiting early...\n');
    // When this scope exits, spawned children are halted immediately
  });

  console.log('Result: Children were halted and cleaned up (no "Done" logged)!\n');
  console.log('='.repeat(50) + '\n');

  // === WRONG: run() creates independent tasks that escape the scope ===
  console.log('=== run(): Breaking Structured Concurrency ===\n');

  yield* scoped(function*() {
    // DON'T DO THIS - these tasks escape to the global scope!
    run(() => task('orphan-a'));
    run(() => task('orphan-b'));

    yield* sleep(100);
    console.log('Scope exiting early...\n');
    // Orphaned tasks keep running - they are NOT children of this scope
  });

  console.log('Result: Orphans were NOT halted - still running!\n');

  // Wait to show orphaned tasks complete on their own
  yield* sleep(600);
  console.log('\n--- Orphans finished on their own (not structured) ---');
});
