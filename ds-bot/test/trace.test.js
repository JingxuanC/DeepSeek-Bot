import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTrace, writeActiveTrace } from '../src/host/trace.js'

test('trace jsonl carries the shared fields and stays private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-trace-'))
  try {
    const env = { ...process.env, ALPHA_TRACE_DIR: dir }
    writeActiveTrace({ traceId: 't1', bot: '研究官', session: 's1', env })
    appendTrace({
      trace_id: 't1',
      bot: '研究官',
      session: 's1',
      tool: 'ask',
      data_source: 'astock',
      latency_ms: 12,
      ok: true,
      asof: '2026-10-22T00:00:00Z',
      review_outcome: 'ok',
    }, env)
    const active = JSON.parse(readFileSync(join(dir, 'active.json'), 'utf8'))
    assert.equal(active.trace_id, 't1')
    assert.equal(active.bot, '研究官')
    const row = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8'))
    for (const key of ['trace_id', 'bot', 'tool', 'data_source', 'latency_ms', 'error_kind', 'asof', 'review_outcome']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), key)
    }
    assert.equal(row.tool, 'ask')
    assert.equal(row.data_source, 'astock')
    assert.equal(row.error_kind, null)
    assert.equal(row.review_outcome, 'ok')
    assert.equal(statSync(join(dir, 'events.jsonl')).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
