// leaky-timers.ts
const timers: ReturnType<typeof setTimeout>[] = [];

async function createLeakyTimer(id: number, ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    const timerId = setTimeout(() => {
      console.log(`Timer ${id} fired after ${ms}ms`);
      resolve();
    }, ms);
    timers.push(timerId);
  });
}

(async function main(): Promise<void> {
  console.log('Starting race...');
  console.time('total');
  
  await Promise.race([
    createLeakyTimer(1, 100),
    createLeakyTimer(2, 200),
    createLeakyTimer(3, 500),
    createLeakyTimer(4, 1000),
  ]);
  
  console.log('Race finished! But watch what happens...');
  console.timeEnd('total');
  
  // We'd need to manually clean up:
  // timers.forEach(id => clearTimeout(id));
})();
