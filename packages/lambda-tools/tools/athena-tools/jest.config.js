import base from '../../jest.config.base.js';

export default {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@moca/lambda-tools-shared$': '<rootDir>/../../shared/src/index.ts',
  },
  // Coverage floor (ratchet): raise these when coverage improves, never lower them.
  coverageThreshold: { global: { statements: 20, branches: 8, functions: 29, lines: 22 } },
};
