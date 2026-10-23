#!/usr/bin/env node
// Ask one named DS Bot and print its answer.
//
//   node apps/ds-bot/scripts/invoke-bot.mjs --bot 研究官 --prompt-file prompt.txt --json
//   node apps/ds-bot/scripts/invoke-bot.mjs --bot 数据官 --prompt "..." --base-url http://127.0.0.1:19390
//
// This talks to a running host's POST /api/bot endpoint "ask". It does not
// start DSH, so it writes into that host's Bot (a fresh session by default).
// RSI's isolated runner (rsi/bots/run-one.mjs) boots its own host instead.
// --dry-run prints the request and does not connect. --no-fresh keeps the
// current session. --asof is stored on the trace.
//
// Auth is the browser session cookie, or --token (the one-time login token
// printed when DSH starts). Exit 0 when the Bot answered, 1 otherwise.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value !== undefined && !String(value).startsWith('--') ? value : true
}
const flag = (name) => args.includes(`--${name}`)

const json = flag('json')
const bot = arg('bot', process.env.RSI_DSH_BOT)
const baseUrl = String(arg('base-url', process.env.DSH_BASE_URL || 'http://127.0.0.1:19390')).replace(/\/+$/, '')
const timeoutMs = Number(arg('timeout-ms', process.env.RSI_DSH_TIMEOUT_MS || 180000)) || 180000
const token = arg('token', process.env.DSH_TOKEN || '')

function emit(payload, code) {
  if (json) console.log(JSON.stringify(payload))
  else if (payload.ok) console.log(payload.text ?? payload.output ?? '')
  else console.error(payload.error?.message || payload.error_kind || 'invoke failed')
  process.exitCode = code
}

function promptText() {
  const file = arg('prompt-file')
  if (typeof file === 'string') return readFileSync(resolve(file), 'utf8')
  const inline = arg('prompt')
  if (typeof inline === 'string') return inline
  return ''
}

if (typeof bot !== 'string' || bot.trim() === '') {
  emit({ ok: false, error: { kind: 'config', message: '--bot is required' } }, 1)
} else if (flag('dry-run')) {
  emit({
    ok: true,
    dryRun: true,
    bot,
    baseUrl,
    endpoint: 'ask',
    timeoutMs,
    promptBytes: Buffer.byteLength(promptText()),
  }, 0)
} else {
  const text = promptText()
  if (text.trim() === '') {
    emit({ ok: false, error: { kind: 'config', message: '--prompt or --prompt-file is required' } }, 1)
  } else {
    try {
      let cookie = String(arg('cookie', process.env.DSH_COOKIE || ''))
      if (!cookie && token) {
        const login = await fetch(`${baseUrl}/?token=${encodeURIComponent(String(token))}`, { redirect: 'manual' })
        const cookies = typeof login.headers.getSetCookie === 'function'
          ? login.headers.getSetCookie()
          : [login.headers.get('set-cookie')].filter(Boolean)
        cookie = cookies.map((value) => String(value).split(';')[0]).filter(Boolean).join('; ')
      }
      const response = await fetch(`${baseUrl}/api/bot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({
          endpoint: 'ask',
          payload: {
            bot,
            text,
            timeoutMs,
            fresh: !flag('no-fresh'),
            ...(typeof arg('asof') === 'string' ? { asof: arg('asof') } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs + 5000),
      })
      const body = await response.json()
      if (!response.ok || body.ok === false) {
        emit({
          ok: false,
          bot,
          error: { kind: 'api', message: body.error?.message || `HTTP ${response.status}` },
        }, 1)
      } else {
        const value = body.value ?? {}
        emit({
          ok: value.ok !== false && typeof value.text === 'string' && value.text !== '',
          bot: value.bot ?? bot,
          text: value.text ?? '',
          output: value.text ?? '',
          trace_id: value.trace_id ?? null,
          sessionId: value.sessionId ?? null,
          usage: value.usage ?? null,
          asof: value.asof ?? null,
          fresh: value.fresh === true,
          error_kind: value.error_kind ?? null,
          review_outcome: value.review_outcome ?? null,
        }, value.ok === false || !value.text ? 1 : 0)
      }
    } catch (error) {
      emit({ ok: false, bot, error: { kind: 'connect', message: error instanceof Error ? error.message : String(error) } }, 1)
    }
  }
}
