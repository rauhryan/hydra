import type { Operation, Stream, Subscription, Signal } from 'effection';
import { main, resource, createSignal, spawn, sleep, each, ensure } from 'effection';
import { EventEmitter } from 'events';

// A stream factory for any EventEmitter event
function eventsFrom<T>(
  emitter: EventEmitter,
  eventName: string
): Stream<T, void> {
  return resource<Subscription<T, void>>(function*(provide) {
    const signal: Signal<T, void> = createSignal<T, void>();

    const handler = (value: T) => signal.send(value);
    emitter.on(eventName, handler);

    try {
      // Provide the subscription (the stream interface)
      const subscription: Subscription<T, void> = yield* signal;
      yield* provide(subscription);
    } finally {
      emitter.off(eventName, handler);
      signal.close();
    }
  });
}

// Usage
await main(function*() {
  const emitter = new EventEmitter();

  // Create multiple independent subscriptions to the same events
  yield* spawn(function*(): Operation<void> {
    for (const data of yield* each(eventsFrom<string>(emitter, 'message'))) {
      console.log('Subscriber A:', data);
      yield* each.next();
    }
  });

  yield* spawn(function*(): Operation<void> {
    for (const data of yield* each(eventsFrom<string>(emitter, 'message'))) {
      console.log('Subscriber B:', data);
      yield* each.next();
    }
  });

  yield* sleep(10);

  emitter.emit('message', 'Hello');
  emitter.emit('message', 'World');

  yield* sleep(100);
});

