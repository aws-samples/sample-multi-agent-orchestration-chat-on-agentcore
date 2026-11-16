export default async function globalTeardown(): Promise<void> {
  await globalThis.__DDB_CONTAINER__?.stop();
}
