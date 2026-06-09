/**
 * CommonJS shim for the pure-ESM `uuid` package.
 *
 * ts-jest transpiles the integration suite to CommonJS, but `uuid` ships only
 * an ESM build (its `exports` map has no `require` entry), so a real `require`
 * fails under jest. Repository integration tests only need *some* unique id —
 * not specifically a UUIDv7 — so we back the v7 export with the platform's
 * `crypto.randomUUID()`. Unit tests that assert on the id format mock `uuid`
 * directly via `jest.mock`, so they are unaffected by this mapping.
 */
const { randomUUID } = require('node:crypto');

module.exports = {
  v4: () => randomUUID(),
  v7: () => randomUUID(),
};
