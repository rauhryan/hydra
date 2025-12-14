/**
 * custom-stream.ts
 *
 * Demonstrates how to create a custom Stream that works with
 * Node.js EventEmitter using a Signal inside a resource.
 */
import type { Stream, Subscription, Signal } from 'effection';
import { main, resource, createSignal, ensure, spawn, sleep, each } from 'effection';
import { EventEmitter } from 'events';

/**
 * A custom Stream factory that wraps EventEmitter events.
 * Each yield* on this stream creates a new subscription.
 */
function eventsFrom<T>(
  emitter: EventEmitter,
  eventName: string
): Stream<T, void> {
  return resource<Subscription<T, void>>(function* (provide) {
    // Create a Signal to bridge events into Effection
    const signal: Signal<T, void> = createSignal<T, void>();

    // Set up the event handler
    const handler = (value: T) => signal.send(value);
    emitter.on(eventName, handler);

    // Ensure cleanup when the subscription is no longer needed
    yield* ensure(() => {
      console.log('  [cleanup] Removing event listener');
      emitter.off(eventName, handler);
      signal.close();
    });

    // Get a subscription from the signal and provide it
    const subscription: Subscription<T, void> = yield* signal;
    yield* provide(subscription);
  });
}

// Demo
await main(function* () {
  console.log('=== Custom Stream from EventEmitter ===\n');

  const emitter = new EventEmitter();

  // Spawn a consumer that listens for 'message' events
  yield* spawn(function* () {
    console.log('Starting to listen for messages...\n');

    let count = 0;
    for (const data of yield* each(eventsFrom<string>(emitter, 'message'))) {
      console.log(`Received: "${data}"`);
      count++;

      if (count >= 3) {
        console.log('\nGot 3 messages, stopping.');
        break;
      }
      yield* each.next();
    }
  });

  // Give the consumer time to set up
  yield* sleep(10);

  // Emit some events
  console.log('Emitting messages...');
  emitter.emit('message', 'Hello');
  emitter.emit('message', 'World');
  emitter.emit('message', 'Goodbye');

  // Wait a bit to see the output
  yield* sleep(100);

  console.log('\nDone!');
});
