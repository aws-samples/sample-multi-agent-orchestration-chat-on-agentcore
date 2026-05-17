/**
 * Integration Test Helpers
 *
 * Utilities for conditionally running integration tests based on
 * environment variable availability.
 */

/**
 * Returns `describe` if all required environment variables are set,
 * otherwise returns `describe.skip` to skip the test suite.
 *
 * This allows integration tests to gracefully skip when the required
 * AWS services or credentials are not configured (e.g., in CI without secrets).
 *
 * @param envVars - Array of required environment variable names
 * @param label - Optional label for the skip message
 * @returns `describe` or `describe.skip`
 *
 * @example
 * ```typescript
 * const describeWithBedrock = describeIfEnv(['BEDROCK_MODEL_ID'], 'Bedrock');
 *
 * describeWithBedrock('my integration test', () => {
 *   it('calls Bedrock API', async () => { ... });
 * });
 * ```
 */
export function describeIfEnv(envVars: string[], label?: string): typeof describe {
  const missing = envVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.log(
      `⏭️  Skipping ${label || 'integration tests'}: missing env vars [${missing.join(', ')}]`
    );
    return describe.skip;
  }
  return describe;
}
