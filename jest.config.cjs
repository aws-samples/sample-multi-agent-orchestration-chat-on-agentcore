/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  passWithNoTests: true,
  testPathIgnorePatterns: ['/node_modules/', '/cdk\\.out/', '/packages/'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: {
          esModuleInterop: true,
          moduleResolution: 'node',
          composite: false,
          incremental: false,
          declaration: false,
          declarationMap: false,
          noEmit: false,
        },
      },
    ],
  },
  testTimeout: 30000,
};
