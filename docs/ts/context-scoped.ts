// context-scoped.ts
import type { Operation, Context } from 'effection';
import { main, createContext, spawn, sleep } from 'effection';

const ThemeContext: Context<string> = createContext<string>('theme');

function* logTheme(label: string): Operation<void> {
  const theme: string = (yield* ThemeContext.get()) ?? 'undefined';
  console.log(`${label}: theme is "${theme}"`);
}

await main(function*() {
  yield* ThemeContext.set('light');
  
  yield* logTheme('main');  // "light"
  
  // Spawn child and WAIT for it to complete
  const childTask = yield* spawn(function*(): Operation<void> {
    // Child can override
    yield* ThemeContext.set('dark');
    yield* logTheme('child');  // "dark"
    
    // Spawn grandchild and wait for it
    const grandchildTask = yield* spawn(function*(): Operation<void> {
      // Grandchild inherits from child
      yield* logTheme('grandchild');  // "dark"
    });
    
    // Wait for grandchild to complete before child exits
    yield* grandchildTask;
  });
  
  // Wait for child (and grandchild) to complete
  yield* childTask;
  
  // Parent is unaffected by child's override
  yield* logTheme('main again');  // "light"
});
