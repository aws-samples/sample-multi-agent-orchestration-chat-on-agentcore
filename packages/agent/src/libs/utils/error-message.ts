/**
 * Message of an unknown thrown value. Duck-typed rather than `instanceof Error`:
 * Node raises fs errors from its own realm, which fails `instanceof` wherever
 * the caller runs in a VM context (jest). Dependency-free so worker threads can
 * import it cheaply.
 */
export function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'Unknown error';
}
