import type { Operation } from 'effection';
import { main, action, sleep } from 'effection';
import { EventEmitter } from 'events';

function once<T>(
  emitter: EventEmitter,
  eventName: string
): Operation<T> {
  return action<T>((resolve, reject) => {
    const handler = (value: T) => resolve(value);
    const errorHandler = (error: Error) => reject(error);

    emitter.on(eventName, handler);
    emitter.on('error', errorHandler);

    return () => {
      emitter.off(eventName, handler);
      emitter.off('error', errorHandler);
    };
  });
}

// Demo showing "once" only captures first event
await main(function*() {
  const emitter = new EventEmitter();

  // Schedule multiple events
  setTimeout(() => {
    console.log('Emitting: first');
    emitter.emit('data', { message: 'first' });
  }, 100);

  setTimeout(() => {
    console.log('Emitting: second');
    emitter.emit('data', { message: 'second' });
  }, 200);

  setTimeout(() => {
    console.log('Emitting: third');
    emitter.emit('data', { message: 'third' });
  }, 300);

  // once() only captures the first event, then cleans up the listener
  const data: { message: string } = yield* once(emitter, 'data');
  console.log('Received:', data.message);

  // Wait to show other events are emitted but ignored
  yield* sleep(400);
  console.log('Done - only captured first event');
});

