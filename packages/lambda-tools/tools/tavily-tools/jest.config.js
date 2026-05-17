import base from '../../jest.config.base.js';

export default {
  ...base,
  // Exclude *.integration.test.ts from the default (unit) run. Integration tests
  // hit the real Tavily API and require TAVILY_API_KEY; they are executed via
  // the dedicated `jest.integration.config.js` / `npm run test:integration`.
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? []), '\\.integration\\.test\\.ts$'],
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@moca/lambda-tools-shared$': '<rootDir>/../../shared/src/index.ts',
  },
};
