// leaky-race.ts
async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

(async function main(): Promise<void> {
  console.time('race');
  await Promise.race([
    sleep(10),
    sleep(1000)
  ]);
  console.timeEnd('race');
})();
