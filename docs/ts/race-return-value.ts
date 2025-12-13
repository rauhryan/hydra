import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

function* fetchFromAPI(name: string, delay: number): Operation<string> {
  console.log(`${name}: starting (${delay}ms)`);
  yield* sleep(delay);
  console.log(`${name}: completed`);
  return `Response from ${name}`;
}

await main(function*() {
  const winner: string = yield* race([
    fetchFromAPI('fast-api', 100),
    fetchFromAPI('slow-api', 500),
  ]);

  console.log('Winner:', winner);
});

