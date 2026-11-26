import test from 'node:test'
import assert from 'node:assert/strict'

import { unifiedDiff } from '../lib/diff.js'

test('identical text produces no diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'x.txt'), '')
})

test('counts added and removed lines', () => {
  const change = unifiedDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n', 'x.txt')
  assert.equal(change.added, 2)
  assert.equal(change.removed, 1)
  assert.match(change.text, /^--- a\/x\.txt$/m)
  assert.match(change.text, /^\+four$/m)
})

test('huge inputs degrade to a summary instead of an O(n*m) table', () => {
  const a = Array.from({ length: 2500 }, (_, index) => `line ${index}`).join('\n')
  const b = `${a}\nlast`
  const started = Date.now()
  const change = unifiedDiff(a, b, 'big.txt')
  assert.equal(change.skipped, true)
  assert.match(change.text, /line diff skipped/)
  assert.ok(Date.now() - started < 1000, 'guard must run before allocating the LCS table')
})
