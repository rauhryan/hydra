import type { Operation } from 'effection';
import { main, sleep } from 'effection';

function* fetchFromAPI(source: string): Operation<string> {
  console.log(`Fetching from ${source}...`);
  yield* sleep(500); // Simulate network delay
  return `Data from ${source}`;
}

await main(function*() {
  console.time('total');

  const dataA: string = yield* fetchFromAPI('api-a');
  const dataB: string = yield* fetchFromAPI('api-b');

  console.log(dataA, dataB);
  console.timeEnd('total'); // ~1000ms - sequential!
});

