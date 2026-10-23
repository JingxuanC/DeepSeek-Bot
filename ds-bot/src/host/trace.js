// JSONL traces shared with the Python report and data servers.
// See packages/quant-report-engine/report_engine/trace.py for the field list.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function tracesDir(env = process.env) {
  if (env.ALPHA_TRACE_DIR) return env.ALPHA_TRACE_DIR
  const home = env.DSH_HOME || join(env.HOME || env.USERPROFILE || '', '.dsh')
  return join(home, 'alpha-desk', 'traces')
}

export function writeActiveTrace({ traceId, bot, session, env = process.env }) {
  const dir = tracesDir(env)
  mkdirSync(dir, { recursive: true })
  const row = {
    trace_id: traceId,
    bot: bot ?? null,
    session: session ?? null,
    started_at: new Date().toISOString(),
  }
  writeFileSync(join(dir, 'active.json'), `${JSON.stringify(row)}\n`, { mode: 0o600 })
  return row
}

export function appendTrace(event, env = process.env) {
  const dir = tracesDir(env)
  mkdirSync(dir, { recursive: true })
  const row = {
    trace_id: event.trace_id ?? null,
    bot: event.bot ?? null,
    session: event.session ?? null,
    tool: event.tool ?? null,
    data_source: event.data_source ?? event.provider ?? null,
    provider: event.provider ?? event.data_source ?? null,
    args_hash: event.args_hash ?? null,
    latency_ms: event.latency_ms ?? null,
    ok: Boolean(event.ok),
    error_kind: event.error_kind ?? null,
    asof: event.asof ?? null,
    artifact_path: event.artifact_path ?? null,
    verify: event.verify ?? null,
    review_outcome: event.review_outcome ?? null,
    ts: event.ts ?? new Date().toISOString(),
  }
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 })
  return row
}
