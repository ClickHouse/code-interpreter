// jest.config.js
const { pathsToModuleNameMapper } = require('ts-jest');
// Import the paths from your tsconfig
const { compilerOptions } = require('./tsconfig.json');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    // This is the directory where your tsconfig.json is located
    prefix: '<rootDir>/'
  }),
  modulePaths: [
    '<rootDir>'
  ],
  verbose: true,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironmentOptions: {
    env: {
      NODE_ENV: 'test'
    }
  }
};