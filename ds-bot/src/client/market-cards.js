// Cards for the market-center plugin's tools. `market_chart` hands the model only a
// compact summary, so its card re-reads the series from the plugin's own same-origin
// route with the call's arguments. `market_insight` carries its prose in the arguments;
// a `read` call has none and falls back to the tool result text.
import { createElement as h, useEffect, useState } from 'react'
import { contentText } from './text.js'

const SNAPSHOT_PATH = '/api/market-center/snapshot'
const ANNOTATIONS_PATH = '/api/market-center/annotations'
const ANNOTATION_POLL_MS = 5000
const BARS = 120
// A-share convention: red is up, green is down. Everything else follows the chat theme.
const RISING = '#e5484d'
const FALLING = '#30a46c'
const SPARK = { width: 260, height: 56, pad: 3 }
// Agent levels need vertical room for their labels; a card without them stays compact.
const ANNOTATED_HEIGHT = 132
const LABEL_GAP = 10
const DASH = { dashed: '5 3', dotted: '1 2' }
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
 * @param {{ height?: number, bounds?: unknown[] }} [options] - a taller chart, or
 *   agent prices that widen the range so a level beyond the closes still fits.
 * @returns {{ points: string, color: string } | null} null when there is nothing to draw.
 */
export function sparkline(closes, options = {}) {
  const values = (Array.isArray(closes) ? closes : []).filter(value => Number.isFinite(value))
  if (values.length < 2) return null
  const height = Number.isFinite(options.height) && options.height > 0 ? options.height : SPARK.height
  const bounds = (Array.isArray(options.bounds) ? options.bounds : []).filter(value => Number.isFinite(value))
  const min = Math.min(...values, ...bounds)
  const max = Math.max(...values, ...bounds)
  const span = max - min || 1
  const stepX = (SPARK.width - SPARK.pad * 2) / (values.length - 1)
  const points = values.map((value, index) => {
    const x = SPARK.pad + index * stepX
    const y = SPARK.pad + ((max - value) / span) * (height - SPARK.pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return { points, color: values.at(-1) >= values[0] ? RISING : FALLING }
}

// The panel polls its annotation set the same way; a tool call is the only thing
// that changes it, so a local read every few seconds is what makes a level the
// agent just drew appear on a card that is already on screen.
function useAnnotations(code) {
  const [annotations, setAnnotations] = useState([])
  useEffect(() => {
    const id = clean(code)
    if (id === '') {
      setAnnotations([])
      return undefined
    }
    const controller = new AbortController()
    let alive = true
    const read = async () => {
      try {
        const response = await fetch(`${ANNOTATIONS_PATH}?code=${encodeURIComponent(id)}`, { signal: controller.signal })
        const body = await response.json().catch(() => null)
        // A failed read keeps the levels already drawn rather than blanking the card.
        if (alive && response.ok && body?.ok === true && Array.isArray(body.annotations)) setAnnotations(body.annotations)
      } catch { /* aborts and transient failures are non-events here */ }
    }
    void read()
    const timer = setInterval(() => { void read() }, ANNOTATION_POLL_MS)
    return () => { alive = false; clearInterval(timer); controller.abort() }
  }, [code])
  return annotations
}

// An intraday bar carries epoch seconds in Beijing wall clock; a marker names a
// trading day, so both sides are compared as that calendar day.
const barDay = (time) => {
  if (typeof time !== 'number' || !Number.isFinite(time)) return clean(time)
  return new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

/**
 * Read one snapshot from the market-center host route.
 * @param {number} [count] - bars to ask for; a card stays compact, a drawer is taller.
 * @throws when the host answers `ok:false` or with something that is not a snapshot.
 */
export async function loadSnapshot(code, period, signal, count = BARS) {
  const query = `code=${encodeURIComponent(code)}&period=${encodeURIComponent(period)}&count=${encodeURIComponent(count)}`
  const response = await fetch(`${SNAPSHOT_PATH}?${query}`, { signal })
  const body = await response.json().catch(() => null)
  if (body?.ok !== true) throw new Error(body?.message ?? `snapshot unavailable (${response.status})`)
  return body
}

// The chart tool's card: name, last price and change over a line sparkline, plus
// the agent's annotations for the same instrument. No canvas and no chart library,
// so a transcript full of these costs one element tree each.
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
  const annotations = useAnnotations(code)

  const snapshot = state.phase === 'ready' ? state.snapshot : undefined
  const change = Number(snapshot?.changePercent)
  const color = Number.isFinite(change) && change < 0 ? FALLING : RISING
  const bars = Array.isArray(snapshot?.bars) ? snapshot.bars : []
  const drawn = bars.filter(bar => Number.isFinite(bar?.close))
  const priceLines = annotations.filter(entry => entry?.kind === 'price-line' && Number.isFinite(Number(entry.price)))
  const markers = annotations.filter(entry => entry?.kind === 'marker' && clean(entry.time) !== '')
  const prices = priceLines.map(entry => Number(entry.price))
  const height = annotations.length > 0 ? ANNOTATED_HEIGHT : SPARK.height
  const line = snapshot ? sparkline(drawn.map(bar => bar.close), { height, bounds: prices }) : null
  const label = [snapshot?.name ?? clean(code), snapshot?.code ?? clean(code)].filter(Boolean).join(' ')

  // The same range the sparkline used, so a level and a marker sit on their price.
  const bounds = [...drawn.map(bar => bar.close), ...prices]
  const min = bounds.length > 0 ? Math.min(...bounds) : 0
  const max = bounds.length > 0 ? Math.max(...bounds) : 1
  const span = max - min || 1
  const yOf = value => SPARK.pad + ((max - value) / span) * (height - SPARK.pad * 2)
  const stepX = drawn.length > 1 ? (SPARK.width - SPARK.pad * 2) / (drawn.length - 1) : 0
  const labelNodes = []
  if (line) {
    // Price labels alternate sides and skip a neighbour they would cover; every
    // line still draws, so a crowded set loses text, never a level.
    const used = { left: [], right: [] }
    priceLines.forEach((entry, index) => {
      const y = yOf(Number(entry.price))
      const side = index % 2 === 0 ? 'right' : 'left'
      if (used[side].some(other => Math.abs(other - y) < LABEL_GAP)) return
      used[side].push(y)
      labelNodes.push(h('span', {
        key: `level-label-${index}`, title: clean(entry.label),
        style: {
          position: 'absolute', top: `${y}px`, [side]: '2px', transform: 'translateY(-50%)', padding: '0 3px', borderRadius: '3px',
          background: 'var(--bt-card, var(--dsw-alias-bg-base, #fff))', color: clean(entry.color) || muted,
          fontSize: '9px', lineHeight: '10px', whiteSpace: 'nowrap', maxWidth: '48%', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none',
        },
      }, clean(entry.label)))
    })
    markers.forEach((entry, index) => {
      const at = drawn.findIndex(bar => barDay(bar?.time) === clean(entry.time))
      if (at < 0) return
      const x = SPARK.pad + at * stepX
      const top = yOf(drawn[at].close)
      const position = entry.position === 'aboveBar' || entry.position === 'belowBar' ? entry.position : 'inBar'
      const offset = position === 'aboveBar' ? 'translate(-50%, -100%)' : position === 'belowBar' ? 'translate(-50%, 0)' : 'translate(-50%, -50%)'
      const left = Math.min(92, Math.max(8, (x / SPARK.width) * 100))
      labelNodes.push(h('span', {
        key: `marker-label-${index}`, title: clean(entry.label),
        style: {
          position: 'absolute', left: `${left}%`, top: `${top + (position === 'aboveBar' ? -8 : position === 'belowBar' ? 8 : 0)}px`,
          transform: offset, padding: '0 3px', borderRadius: '3px', background: 'var(--bt-card, var(--dsw-alias-bg-base, #fff))',
          color: clean(entry.color) || muted, fontSize: '9px', lineHeight: '10px', whiteSpace: 'nowrap', maxWidth: '46%',
          overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none',
        },
      }, clean(entry.label)))
    })
  }
  return h('div', { className: 'bt-market-chart', role: 'group', 'aria-label': `Chart: ${label || 'market chart'}`, style: card },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
      h('span', { style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, snapshot?.name ?? clean(code)),
      h('span', { style: { fontSize: '11px', color: faint, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, snapshot?.code ?? clean(code)),
      actions?.openPanel
        ? h('button', {
          type: 'button',
          onClick: () => actions.openPanel('market', clean(code)),
          title: '在侧边栏打开行情图表',
          style: { marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary, #4c7dff)', font: 'inherit', fontSize: '11px', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' },
        }, '行情中心')
        : null,
      h('span', { style: { marginLeft: actions?.openMarket ? '8px' : 'auto', fontSize: '11px', color: faint, whiteSpace: 'nowrap' } }, PERIOD_LABELS[periodId] ?? periodId),
      annotations.length > 0
        ? h('span', {
          title: `${annotations.length} agent annotations`,
          style: { fontSize: '11px', color: 'var(--dsw-alias-brand-primary, #4c7dff)', border: '1px solid rgba(127, 127, 127, .3)', borderRadius: '999px', padding: '0 6px', whiteSpace: 'nowrap' },
        }, `${annotations.length} 项标绘`)
        : null),
    state.phase === 'loading' ? h('div', { style: { fontSize: '12px', color: muted } }, 'Loading chart…')
      : state.phase === 'error' ? h('div', { style: { fontSize: '12px', color: muted }, title: state.message }, 'Chart unavailable')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', fontVariantNumeric: 'tabular-nums' } },
            h('span', { style: { fontSize: '22px', fontWeight: 600, lineHeight: '26px', letterSpacing: '-.01em' } }, priceText(snapshot?.price)),
            h('span', { style: { fontSize: '12px', fontWeight: 600, color } }, percentText(change)),
            h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: faint } }, `${bars.length} bars`)),
          line
            ? h('div', { style: { position: 'relative', height: `${height}px` } },
              h('svg', {
                width: '100%', height, viewBox: `0 0 ${SPARK.width} ${height}`, preserveAspectRatio: 'none',
                role: 'img', 'aria-label': `Close price, ${bars.length} bars${annotations.length > 0 ? `, ${annotations.length} annotations` : ''}`,
                style: { position: 'absolute', inset: 0, display: 'block', width: '100%', height: `${height}px` },
              },
              h('polyline', {
                points: line.points, fill: 'none', stroke: line.color, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
              }),
              ...priceLines.map((entry, index) => {
                const y = yOf(Number(entry.price))
                return h('line', {
                  key: `level-${index}`, x1: 0, x2: SPARK.width, y1: y, y2: y, stroke: clean(entry.color) || muted,
                  strokeWidth: 1, strokeDasharray: DASH[entry.style], vectorEffect: 'non-scaling-stroke',
                }, h('title', null, clean(entry.label)))
              }),
              ...markers.map((entry, index) => {
                const at = drawn.findIndex(bar => barDay(bar?.time) === clean(entry.time))
                if (at < 0) return null
                const x = SPARK.pad + at * stepX
                const y = yOf(drawn[at].close)
                return h('line', {
                  key: `marker-${index}`, x1: x, x2: x, y1: y - 6, y2: y + 6, stroke: clean(entry.color) || muted,
                  strokeWidth: 1, vectorEffect: 'non-scaling-stroke',
                }, h('title', null, clean(entry.label)))
              })),
              ...labelNodes)
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
