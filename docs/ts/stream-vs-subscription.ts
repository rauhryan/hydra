/**
 * stream-vs-subscription.ts
 *
 * Demonstrates the relationship between Stream and Subscription.
 *
 * Stream is a type alias: Operation<Subscription<T, TReturn>>
 * When you yield* a Stream, you get a Subscription.
 * Each yield* creates a NEW, independent Subscription with its own queue.
 */
import type { Channel, Stream, Subscription } from 'effection';
import { main, createChannel, spawn, sleep } from 'effection';

await main(function* () {
  console.log('=== Stream vs Subscription ===\n');

  // Channel implements Stream<number, void>
  // You can see this in the type: Channel<T, TClose> extends Stream<T, TClose>
  const channel: Channel<number, void> = createChannel<number, void>();

  // Each yield* on a Stream creates a NEW subscription with its own queue
  const sub1: Subscription<number, void> = yield* channel;
  const sub2: Subscription<number, void> = yield* channel;

  console.log('Created two subscriptions from the same channel\n');

  yield* spawn(function* () {
    yield* channel.send(1);
    yield* channel.send(2);
  });

  yield* sleep(10);

  // Both subscriptions receive ALL messages independently
  // Each has its own queue - they don't compete for messages
  console.log('sub1:', (yield* sub1.next()).value); // 1
  console.log('sub1:', (yield* sub1.next()).value); // 2
  console.log('sub2:', (yield* sub2.next()).value); // 1
  console.log('sub2:', (yield* sub2.next()).value); // 2

  console.log('\nBoth subscriptions received all messages!');
  console.log('Each yield* on a Stream creates an independent queue.');
});
