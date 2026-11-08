import base from '../../jest.config.base.js';

export default {
  ...base,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@moca/lambda-tools-shared$': '<rootDir>/../../shared/src/index.ts',
  },
};
