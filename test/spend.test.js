import test from 'node:test';
import assert from 'node:assert/strict';
import { withinSpendCap } from '../src/db.js';

test('daily cap rejects $1.20 scene after $19.20 at a $20 cap', () => {
  assert.equal(withinSpendCap(1920, 15 * 8, 2000), false);
  assert.equal(withinSpendCap(1880, 15 * 8, 2000), true);
});
