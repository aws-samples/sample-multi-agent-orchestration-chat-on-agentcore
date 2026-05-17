/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/bin', '<rootDir>/lib', '<rootDir>/config'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/cdk.out/'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: {
          esModuleInterop: true,
          module: 'commonjs',
          moduleResolution: 'node',
          types: ['jest', 'node'],
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
