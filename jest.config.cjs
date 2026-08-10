/**
 * Native-ESM jest. The research scripts are all `.mjs` and the repo is `type: module`, so there
 * is deliberately no babel transform here — the code under test runs exactly as the archive
 * jobs run it, rather than through a compiler that could paper over a module-resolution bug.
 */
module.exports = {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['mjs', 'js', 'json'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  testMatch: ['**/__tests__/**/*.test.js'],
};
