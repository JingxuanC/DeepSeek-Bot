// Cards for the market-center plugin's tools. `market_chart` hands the model only a
// compact summary, so its card re-reads the series from the plugin's own same-origin
// route with the call's arguments. `market_insight` carries its prose in the arguments;
// a `read` call has none and falls back to the tool result text.
import { createElement as h, useEffect, useState } from 'react'
import { contentText } from './text.js'

const SNAPSHOT_PATH = '/api/market-center/snapshot'
const BARS = 120
// A-share convention: red is up, green is down. Everything else follows the chat theme.
const RISING = '#e5484d'
const FALLING = '#30a46c'
const SPARK = { width: 260, height: 56, pad: 3 }
const PERIOD_LABELS = { day: 'Day', week: 'Week', month: 'Month', '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m', '60min': '60m' }

const card = {
  width: '100%',
  maxWidth: 'var(--dsh-chat-content-width, 748px)',
  boxSizing: 'border-box',
  margin: '0 auto 8px',
  padding: '10px 14px',
  borderRadius: '12px',
  border: '1px solid var(--bt-line, rgba(127, 127, 127, .18))',
  background: 'var(--bt-card, var(--dsw-alias-bg-base, #fff))',
  color: 'var(--dsw-alias-label-primary, var(--bt-ink, #141414))',
  font: 'inherit',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}
const muted = 'var(--dsw-alias-label-secondary, var(--bt-ink-2, rgba(127, 127, 127, .8)))'
const faint = 'var(--dsw-alias-label-tertiary, var(--bt-ink-3, rgba(127, 127, 127, .6)))'

const clean = value => (typeof value === 'string' ? value.trim() : '')
const priceText = value => (Number.isFinite(value) && value > 0 ? value.toFixed(2) : '—')
const percentText = value => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—')

/**
 * Map a close series onto an SVG polyline in the card's fixed viewBox.
 * @param {unknown[]} closes - closes, oldest first.
 * @returns {{ points: string, color: string } | null} null when there is nothing to draw.
 */
export function sparkline(closes) {
  const values = (Array.isArray(closes) ? closes : []).filter(value => Number.isFinite(value))
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = (SPARK.width - SPARK.pad * 2) / (values.length - 1)
  const points = values.map((value, index) => {
    const x = SPARK.pad + index * stepX
    const y = SPARK.pad + ((max - value) / span) * (SPARK.height - SPARK.pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return { points, color: values.at(-1) >= values[0] ? RISING : FALLING }
}

/**
 * Read one snapshot from the market-center host route.
 * @throws when the host answers `ok:false` or with something that is not a snapshot.
 */
export async function loadSnapshot(code, period, signal) {
  const query = `code=${encodeURIComponent(code)}&period=${encodeURIComponent(period)}&count=${BARS}`
  const response = await fetch(`${SNAPSHOT_PATH}?${query}`, { signal })
  const body = await response.json().catch(() => null)
  if (body?.ok !== true) throw new Error(body?.message ?? `snapshot unavailable (${response.status})`)
  return body
}

// The chart tool's card: name, last price and change over a line sparkline. No canvas
// and no chart library, so a transcript full of these costs one element tree each.
export function MarketChartCell({ code, period, actions }) {
  const periodId = clean(period) || 'day'
  const [state, setState] = useState({ phase: 'loading' })
  useEffect(() => {
    if (clean(code) === '') {
      setState({ phase: 'error', message: 'No instrument code' })
      return undefined
    }
    const controller = new AbortController()
    let alive = true
    setState({ phase: 'loading' })
    loadSnapshot(code, periodId, controller.signal).then(
      snapshot => { if (alive) setState({ phase: 'ready', snapshot }) },
      (error) => { if (alive) setState({ phase: 'error', message: error?.message ?? 'unavailable' }) },
    )
    return () => { alive = false; controller.abort() }
  }, [code, periodId])

  const snapshot = state.phase === 'ready' ? state.snapshot : undefined
  const change = Number(snapshot?.changePercent)
  const color = Number.isFinite(change) && change < 0 ? FALLING : RISING
  const bars = Array.isArray(snapshot?.bars) ? snapshot.bars : []
  const line = snapshot ? sparkline(bars.map(bar => bar?.close)) : null
  const label = [snapshot?.name ?? clean(code), snapshot?.code ?? clean(code)].filter(Boolean).join(' ')
  return h('div', { className: 'bt-market-chart', role: 'group', 'aria-label': `Chart: ${label || 'market chart'}`, style: card },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
      h('span', { style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, snapshot?.name ?? clean(code)),
      h('span', { style: { fontSize: '11px', color: faint, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, snapshot?.code ?? clean(code)),
      actions?.openPanel
        ? h('button', {
          type: 'button',
          onClick: () => actions.openPanel('market'),
          title: '打开行情中心',
          style: { marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary, #4c7dff)', font: 'inherit', fontSize: '11px', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' },
        }, '行情中心')
        : null,
      h('span', { style: { marginLeft: actions?.openPanel ? '8px' : 'auto', fontSize: '11px', color: faint, whiteSpace: 'nowrap' } }, PERIOD_LABELS[periodId] ?? periodId)),
    state.phase === 'loading' ? h('div', { style: { fontSize: '12px', color: muted } }, 'Loading chart…')
      : state.phase === 'error' ? h('div', { style: { fontSize: '12px', color: muted }, title: state.message }, 'Chart unavailable')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', fontVariantNumeric: 'tabular-nums' } },
            h('span', { style: { fontSize: '22px', fontWeight: 600, lineHeight: '26px', letterSpacing: '-.01em' } }, priceText(snapshot?.price)),
            h('span', { style: { fontSize: '12px', fontWeight: 600, color } }, percentText(change)),
            h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: faint } }, `${bars.length} bars`)),
          line
            ? h('svg', {
              width: '100%', height: SPARK.height, viewBox: `0 0 ${SPARK.width} ${SPARK.height}`, preserveAspectRatio: 'none',
              role: 'img', 'aria-label': `Close price, ${bars.length} bars`, style: { display: 'block', width: '100%', height: `${SPARK.height}px` },
            }, h('polyline', {
              points: line.points, fill: 'none', stroke: line.color, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
            }))
            : h('div', { style: { fontSize: '12px', color: muted } }, 'No bars available')))
}

// The insight tool's card: the brief it wrote, or the result text of a `read`.
export function MarketInsightCell({ title, body, content }) {
  const head = clean(title).slice(0, 120)
  const brief = clean(body)
  if (head === '' && brief === '') {
    const result = contentText(content).trim()
    if (result === '') return null
    return h('div', { className: 'bt-market-insight', role: 'note', style: card },
      h('div', { style: { fontSize: '11px', color: faint, textTransform: 'uppercase', letterSpacing: '.04em' } }, 'Market insight'),
      h('div', { style: { fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap' } }, result))
  }
  return h('div', { className: 'bt-market-insight', role: 'note', style: card },
    h('div', { style: { fontSize: '11px', color: faint, textTransform: 'uppercase', letterSpacing: '.04em' } }, 'Market insight'),
    head ? h('div', { style: { fontSize: '13px', fontWeight: 600, lineHeight: '19px' } }, head) : null,
    brief ? h('div', { style: { fontSize: '12px', lineHeight: '18px', color: muted, whiteSpace: 'pre-wrap' } }, brief) : null)
}
