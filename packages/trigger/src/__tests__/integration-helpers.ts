/**
 * Integration Test Helpers (trigger)
 *
 * Mirrors packages/agent/src/tests/integration-helpers.ts: returns `describe`
 * when all required env vars are present, otherwise `describe.skip`, so
 * integration suites become a no-op (rather than a hard failure) in
 * environments without the required AWS / Cognito configuration.
 *
 * `describe` is referenced as the Jest ambient global (not imported from
 * '@jest/globals') so that `typeof describe` includes `.skip` / `.only`.
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
