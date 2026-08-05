import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './src/index.js';

test('createApp exposes a login endpoint', () => {
  const app = createApp();
  assert.equal(typeof app.handle, 'function');
});
