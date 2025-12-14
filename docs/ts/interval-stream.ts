/**
 * interval-stream.ts
 *
 * Demonstrates using interval() as a Stream producer.
 * interval(ms) returns a Stream that emits void values at regular intervals.
 */
import { main, interval, each } from 'effection';

await main(function* () {
  console.log('=== interval() Stream Example ===\n');
  console.log('Counting 5 ticks, one per second...\n');

  let count = 0;

  for (const _ of yield* each(interval(1000))) {
    console.log(`tick ${++count}`);

    if (count >= 5) {
      console.log('\nReached 5 ticks, breaking out of loop.');
      break;
    }
    yield* each.next();
  }

  console.log('Done!');
});
