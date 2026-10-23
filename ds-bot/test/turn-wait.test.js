import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnWaiters } from '../src/host/turn-wait.js'

test('skip drops the turn that was already in flight', async () => {
  const waiters = createTurnWaiters()
  const pending = waiters.awaitNext('s', 500, { skip: 1 })
  waiters.notify('s', { ok: true, text: 'old', error_kind: null })
  await new Promise((done) => setTimeout(done, 20))
  let settled = false
  pending.then(() => { settled = true })
  await new Promise((done) => setTimeout(done, 20))
  assert.equal(settled, false)
  waiters.notify('s', { ok: true, text: 'new', error_kind: null })
  const result = await pending
  assert.equal(result.text, 'new')
  assert.equal(result.ok, true)
})

test('timeout and cancel resolve without hanging', async () => {
  const waiters = createTurnWaiters()
  const timed = await waiters.awaitNext('slow', 20)
  assert.equal(timed.ok, false)
  assert.equal(timed.error_kind, 'timeout')

  const pending = waiters.awaitNext('gone', 500)
  pending.cancel()
  const cancelled = await pending
  assert.equal(cancelled.error_kind, 'cancelled')
})
