/**
 * Jest config for the agent's real-AWS integration suites.
 *
 * Two tiers of suites:
 *
 *  1. Always collected (they self-skip via env guards inside the file):
 *       - tests/developer-auth-identity.integration.test.ts
 *       - __tests__/qwen3-model.integration.test.ts (opt-in: RUN_BEDROCK_QWEN_INTEGRATION)
 *
 *  2. Real-AWS service suites that hit CodeInterpreter / Browser / S3. These call
 *     live AWS on collection (module-level beforeAll), so they are only collected
 *     when RUN_AWS_INTEGRATION=1 — otherwise an env without AWS credentials would
 *     error rather than skip. Enable with:
 *       RUN_AWS_INTEGRATION=1 npm run test:integration -w @moca/agent
 */

const awsServiceSuites = process.env.RUN_AWS_INTEGRATION
  ? [
      '**/runtime/tools/code-interpreter/__tests__/client.integration.test.ts',
      '**/runtime/tools/browser/__tests__/browser.integration.test.ts',
      '**/services/__tests__/workspace-sync.integration.test.ts',
    ]
  : [];

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },
  testMatch: [
    '**/tests/developer-auth-identity.integration.test.ts',
    '**/__tests__/qwen3-model.integration.test.ts',
    ...awsServiceSuites,
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60000,
};
