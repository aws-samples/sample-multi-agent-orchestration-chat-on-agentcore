import base from '../jest.config.base.js';

export default {
  ...base,
  // Coverage floor (ratchet): raise these when coverage improves, never lower them.
  coverageThreshold: { global: { statements: 54, branches: 54, functions: 53, lines: 57 } },
};
