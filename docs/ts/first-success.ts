import type { Operation } from 'effection';
import { main, race, sleep } from 'effection';

function* fetchWeather(service: string, delay: number, shouldFail: boolean): Operation<string> {
  console.log(`${service}: fetching...`);
  yield* sleep(delay);
  if (shouldFail) {
    throw new Error(`${service} failed`);
  }
  return `Weather from ${service}: Sunny, 72°F`;
}

await main(function*() {
  try {
    const weather: string = yield* race([
      fetchWeather('service-a', 100, true),   // Fast but fails
      fetchWeather('service-b', 200, false),  // Slower but succeeds
      fetchWeather('service-c', 300, false),  // Slowest
    ]);

    console.log(weather);
  } catch (error) {
    console.log('All services failed');
  }
});

