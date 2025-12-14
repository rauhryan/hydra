import type { Channel, Subscription } from 'effection';
import { main, createChannel } from 'effection';

await main(function*() {
  const channel: Channel<string, void> = createChannel<string, void>();

  // Send before subscribing - message is LOST!
  yield* channel.send('this is lost');

  // Now subscribe
  const subscription: Subscription<string, void> = yield* channel;

  yield* channel.send('this is received');

  const result = yield* subscription.next();
  console.log(result.value); // 'this is received'
});

