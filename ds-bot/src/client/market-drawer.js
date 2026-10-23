// A market drawer owned by the Bot page. The market-center plugin mounts a
// `market` main panel, which replaces the conversation; a chart card or the
// header button instead opens this fixed right column so the conversation stays
// mounted behind it.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './icons.js'
import { loadSnapshot } from './market-cards.js'

export const MARKET_DRAWER_EVENT = 'market-center:drawer'
export const PERIODS = ['1min', '5min', '15min', '30min', '60min', 'day', 'week', 'month']
export const DEFAULT_MARKET_CODE = 'sh600519'
export const PERIOD_LABELS = { '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m', '60min': '60m', day: 'Day', week: 'Week', month: 'Month' }

const ANNOTATIONS_PATH = '/api/market-center/annotations'
const ANNOTATION_POLL_MS = 5000
const BARS = 160
// A-share convention: red is up, green is down. Everything else follows the theme.
const RISING = '#e5484d'
const FALLING = '#30a46c'
const DASH = { dashed: '5 3', dotted: '1 2' }
// The viewBox is fixed so the chart scales with the drawer without measuring it.
const CHART = { width: 420, height: 280, left: 6, right: 60, top: 10, bottom: 20 }
const GRID = 'rgba(127, 127, 127, .22)'
const AXIS = 'rgba(127, 127, 127, .78)'
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

const clean = value => (typeof value === 'string' ? value.trim() : '')
const priceText = value => (Number.isFinite(value) && value > 0 ? value.toFixed(2) : '—')
const percentText = value => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—')

/**
 * Shorten a label to a pixel budget, counting a CJK glyph as a full font size.
 * SVG text has no ellipsis of its own, and a level label that overflows the
 * right gutter would scroll the drawer sideways.
 */
export function fitLabel(value, maxWidth, fontSize) {
  const text = clean(value)
  let used = 0
  let out = ''
  for (const char of text) {
    used += WIDE_CHAR.test(char) ? fontSize : fontSize * 0.58
    if (used > maxWidth) return `${out}…`
    out += char
  }
  return out
}

/**
 * Normalise the many spellings of one A-share code into `sh|sz|bj` + digits,
 * the vocabulary the market-center routes accept.
 * @param {unknown} value - `600519`, `sh600519`, `600519.SH`, ...
 * @returns {string} the normalised code, or '' when it is not an A-share.
 */
export function normalizeCode(value) {
  const text = clean(value).toLowerCase()
  if (text === '') return ''
  let prefix = ''
  let digits = ''
  const prefixed = /^(sh|sz|bj)(\d{6})$/.exec(text)
  const suffixed = /^(\d{6})\.(sh|ss|sz|bj)$/.exec(text)
  const bare = /^(\d{6})$/.exec(text)
  if (prefixed) {
    prefix = prefixed[1]
    digits = prefixed[2]
  } else if (suffixed) {
    prefix = suffixed[2] === 'ss' ? 'sh' : suffixed[2]
    digits = suffixed[1]
  } else if (bare) {
    digits = bare[1]
  } else {
    return ''
  }
  if (prefix === '') {
    const head = digits[0]
    if (head === '6') prefix = 'sh'
    else if (head === '0' || head === '3') prefix = 'sz'
    else if (head === '4' || head === '8') prefix = 'bj'
    else return ''
  }
  return `${prefix}${digits}`
}

/** A drawer request without a code keeps the instrument on screen, else the default. */
export function drawerTarget(code, current) {
  return normalizeCode(code) || normalizeCode(current) || DEFAULT_MARKET_CODE
}

/** A valid period id, or the default `day`. */
export function periodOf(value) {
  const text = clean(value)
  return PERIODS.includes(text) ? text : 'day'
}

/** The quote's `yyyyMMddHHmmss` stamp as readable local-market time. */
export function asOfText(quoteTime) {
  const text = clean(quoteTime)
  if (!/^\d{14}$/.test(text)) return ''
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`
}

// An intraday bar carries epoch seconds in Beijing wall clock; a marker names a
// trading day, so both sides are compared as that calendar day.
const barDay = (time) => {
  if (typeof time !== 'number' || !Number.isFinite(time)) return clean(time)
  return new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

/** The bar a marker names, or -1 when the visible window does not reach it. */
export function barIndexAt(bars, time) {
  const day = clean(time)
  if (day === '') return -1
  return bars.findIndex(bar => barDay(bar?.time) === day)
}

/**
 * Split the annotation set into the two kinds the drawer draws.
 * Unknown kinds are ignored rather than rendered as broken geometry.
 */
export function annotationModel(annotations) {
  const list = Array.isArray(annotations) ? annotations : []
  const priceLines = []
  const markers = []
  for (const entry of list) {
    const price = Number(entry?.price)
    if (entry?.kind === 'price-line' && price > 0 && Number.isFinite(price)) {
      priceLines.push({
        price,
        label: clean(entry.label),
        color: clean(entry.color),
        style: entry.style === 'dashed' || entry.style === 'dotted' ? entry.style : 'solid',
      })
    } else if (entry?.kind === 'marker' && clean(entry.time) !== '') {
      markers.push({
        time: clean(entry.time),
        label: clean(entry.label),
        color: clean(entry.color),
        position: entry.position === 'aboveBar' || entry.position === 'belowBar' ? entry.position : 'inBar',
      })
    }
  }
  return { priceLines, markers }
}

/** Map annotations onto bar indexes; a marker outside the series keeps no index. */
export function mapAnnotations(annotations, bars) {
  const { priceLines, markers } = annotationModel(annotations)
  const series = Array.isArray(bars) ? bars : []
  return {
    priceLines,
    markers: markers.map(marker => ({ ...marker, index: barIndexAt(series, marker.time) })).filter(marker => marker.index >= 0),
  }
}

/**
 * Lay out candles, levels and markers in the chart's viewBox.
 * The price range includes annotation levels, so a level beyond the closes is
 * still on screen; a series with no valid OHLC bar answers with no candles.
 */
export function chartModel(bars, annotations) {
  const candles = (Array.isArray(bars) ? bars : []).map(bar => ({
    time: bar?.time,
    open: Number(bar?.open),
    high: Number(bar?.high),
    low: Number(bar?.low),
    close: Number(bar?.close),
  })).filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
  const mapped = mapAnnotations(annotations, candles)
  const values = [...candles.flatMap(bar => [bar.low, bar.high]), ...mapped.priceLines.map(line => line.price)]
  let min = values.length > 0 ? Math.min(...values) : 0
  let max = values.length > 0 ? Math.max(...values) : 1
  if (min === max) {
    const nudge = Math.abs(min) * 0.01 || 1
    min -= nudge
    max += nudge
  }
  const pad = (max - min) * 0.03
  min -= pad
  max += pad
  const span = max - min || 1
  const plotWidth = CHART.width - CHART.left - CHART.right
  const plotHeight = CHART.height - CHART.top - CHART.bottom
  const slot = plotWidth / Math.max(1, candles.length)
  const body = Math.max(1, Math.min(8, slot * 0.62))
  const xOf = index => CHART.left + slot * (index + 0.5)
  const yOf = value => CHART.top + ((max - value) / span) * plotHeight
  return {
    min,
    max,
    span,
    body,
    slot,
    candles: candles.map((bar, index) => ({
      ...bar,
      index,
      x: xOf(index),
      yOpen: yOf(bar.open),
      yClose: yOf(bar.close),
      yHigh: yOf(bar.high),
      yLow: yOf(bar.low),
      up: bar.close >= bar.open,
    })),
    priceLines: mapped.priceLines.map(line => ({ ...line, y: yOf(line.price) })),
    markers: mapped.markers.map(marker => ({ ...marker, x: xOf(marker.index), y: yOf(candles[marker.index].close) })),
  }
}

/** The date or clock label the chart's bottom axis uses for one bar. */
export function barTick(time) {
  if (typeof time === 'number' && Number.isFinite(time)) {
    const iso = new Date((time + 8 * 3600) * 1000).toISOString()
    return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
  }
  const day = clean(time)
  return day === '' ? '' : day.slice(5)
}

/** Dispatch the drawer request. A missing code opens the current/default instrument. */
export function openMarketDrawer(code, target = globalThis.window) {
  target.dispatchEvent(new CustomEvent(MARKET_DRAWER_EVENT, { detail: { code: code ?? null } }))
}

/** Dispatch a close request, for a caller that has no reference to the drawer. */
export function closeMarketDrawer(target = globalThis.window) {
  target.dispatchEvent(new CustomEvent(MARKET_DRAWER_EVENT, { detail: { close: true } }))
}

// The panel polls its annotation set; a tool call is the only thing that changes
// it, so a local read every few seconds is what makes a level the agent just drew
// appear on a drawer that is already open.
function useAnnotations(code, open) {
  const [annotations, setAnnotations] = useState([])
  useEffect(() => {
    setAnnotations([])
    if (!open || code === '') return undefined
    const controller = new AbortController()
    let alive = true
    const read = async () => {
      try {
        const response = await fetch(`${ANNOTATIONS_PATH}?code=${encodeURIComponent(code)}`, { signal: controller.signal })
        const body = await response.json().catch(() => null)
        // A failed read keeps the levels already drawn rather than blanking the chart.
        if (alive && response.ok && body?.ok === true && Array.isArray(body.annotations)) setAnnotations(body.annotations)
      } catch { /* aborts and transient failures are non-events here */ }
    }
    void read()
    const timer = setInterval(() => { void read() }, ANNOTATION_POLL_MS)
    return () => { alive = false; clearInterval(timer); controller.abort() }
  }, [open, code])
  return annotations
}

function useSnapshot(code, period, open, reload) {
  const [state, setState] = useState({ phase: 'idle' })
  useEffect(() => {
    if (!open || code === '') {
      setState({ phase: 'idle' })
      return undefined
    }
    const controller = new AbortController()
    let alive = true
    setState({ phase: 'loading' })
    loadSnapshot(code, period, controller.signal, BARS).then(
      snapshot => { if (alive) setState({ phase: 'ready', snapshot }) },
      (error) => { if (alive) setState({ phase: 'error', message: error?.message ?? 'unavailable' }) },
    )
    return () => { alive = false; controller.abort() }
  }, [open, code, period, reload])
  return state
}

function Chart({ snapshot, annotations }) {
  const bars = Array.isArray(snapshot?.bars) ? snapshot.bars : []
  const model = chartModel(bars, annotations)
  if (model.candles.length === 0) return h('div', { style: { padding: '24px 0', color: AXIS, fontSize: '12px' } }, 'No bars available')
  const grid = [model.max, model.max - model.span / 3, model.max - (model.span * 2) / 3, model.min]
  const first = model.candles[0]
  const last = model.candles[model.candles.length - 1]
  const middle = model.candles[Math.floor(model.candles.length / 2)]
  return h('svg', {
    viewBox: `0 0 ${CHART.width} ${CHART.height}`,
    width: '100%', role: 'img', 'aria-label': `Candlestick chart, ${model.candles.length} bars, ${annotations.length} annotations`,
    style: { display: 'block', width: '100%', height: 'auto', overflow: 'visible' },
  },
  h('g', null,
    grid.map((value, index) => {
      const y = CHART.top + ((model.max - value) / model.span) * (CHART.height - CHART.top - CHART.bottom)
      return h('g', { key: `grid-${index}` },
        h('line', { x1: CHART.left, x2: CHART.width - CHART.right, y1: y, y2: y, stroke: GRID, strokeWidth: 1 }),
        h('text', {
          x: CHART.width - CHART.right + 4, y: y + 3, textAnchor: 'start',
          style: { fill: AXIS, fontSize: '10px', fontVariantNumeric: 'tabular-nums' },
        }, value.toFixed(2)))
    }),
    model.candles.map(candle => h('g', { key: `candle-${candle.index}` },
      h('line', {
        x1: candle.x, x2: candle.x, y1: candle.yHigh, y2: candle.yLow,
        stroke: candle.up ? RISING : FALLING, strokeWidth: 1, shapeRendering: 'crispEdges',
      }),
      h('rect', {
        x: candle.x - model.body / 2, y: Math.min(candle.yOpen, candle.yClose),
        width: model.body, height: Math.max(1, Math.abs(candle.yClose - candle.yOpen)),
        fill: candle.up ? RISING : FALLING, shapeRendering: 'crispEdges',
      }))),
    model.priceLines.map((line, index) => h('g', { key: `level-${index}` },
      h('line', {
        x1: CHART.left, x2: CHART.width - CHART.right, y1: line.y, y2: line.y,
        stroke: line.color || AXIS, strokeWidth: 1, strokeDasharray: DASH[line.style], opacity: 0.9,
      }),
      h('text', {
        x: CHART.width - CHART.right + 4, y: line.y + 3, textAnchor: 'start',
        style: { fill: line.color || AXIS, fontSize: '9px' },
      }, fitLabel(line.label || priceText(line.price), 52, 9)),
      h('title', null, clean(line.label) || priceText(line.price)))),
    model.markers.map((marker, index) => {
      const labelY = marker.position === 'aboveBar' ? marker.y - 12 : marker.position === 'belowBar' ? marker.y + 20 : marker.y - 8
      const labelX = Math.max(54, Math.min(CHART.width - CHART.right - 6, marker.x))
      return h('g', { key: `marker-${index}` },
        h('line', { x1: marker.x, x2: marker.x, y1: marker.y - 7, y2: marker.y + 7, stroke: marker.color || AXIS, strokeWidth: 1 }),
        h('circle', { cx: marker.x, cy: marker.y, r: 2, fill: marker.color || AXIS }),
        h('text', {
          x: labelX, y: labelY, textAnchor: 'middle',
          style: { fill: marker.color || AXIS, fontSize: '9px' },
        }, fitLabel(marker.label, 96, 9)),
        h('title', null, clean(marker.label)))
    }),
    h('text', { x: first.x, y: CHART.height - 5, textAnchor: 'start', style: { fill: AXIS, fontSize: '10px' } }, barTick(first.time)),
    h('text', { x: middle.x, y: CHART.height - 5, textAnchor: 'middle', style: { fill: AXIS, fontSize: '10px' } }, barTick(middle.time)),
    h('text', { x: last.x, y: CHART.height - 5, textAnchor: 'end', style: { fill: AXIS, fontSize: '10px' } }, barTick(last.time))))
}

const drawer = {
  position: 'fixed',
  top: 'var(--dsh-frame-chrome-top, 0px)',
  right: 0,
  bottom: 0,
  width: 'min(420px, 100vw)',
  zIndex: 100000,
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  background: 'var(--bt-card, var(--dsw-alias-bg-base, #fff))',
  color: 'var(--dsw-alias-label-primary, var(--bt-ink, #141414))',
  borderLeft: '1px solid var(--bt-line-2, rgba(127, 127, 127, .22))',
  boxShadow: '-18px 0 48px -24px rgba(0, 0, 0, .35)',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  pointerEvents: 'auto',
}
const muted = 'var(--dsw-alias-label-secondary, var(--bt-ink-2, rgba(127, 127, 127, .8)))'
const faint = 'var(--dsw-alias-label-tertiary, var(--bt-ink-3, rgba(127, 127, 127, .6)))'

const head = { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px 6px', flex: 'none' }
const body = { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: '10px' }
const row = { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }
const input = {
  flex: 1, minWidth: 0, height: '30px', boxSizing: 'border-box', padding: '0 8px', borderRadius: '8px',
  border: '1px solid var(--bt-line-2, rgba(127, 127, 127, .24))', background: 'transparent',
  color: 'inherit', font: 'inherit', fontSize: '12px', outline: 'none',
}
const primary = {
  height: '28px', padding: '0 10px', border: 0, borderRadius: '7px', cursor: 'pointer',
  background: 'var(--bt-accent, #4d6bfe)', color: 'var(--bt-accent-ink, #fff)', font: 'inherit', fontSize: '12px',
}
const quiet = {
  height: '26px', padding: '0 9px', border: '1px solid var(--bt-line-2, rgba(127, 127, 127, .24))',
  borderRadius: '7px', background: 'transparent', color: muted, font: 'inherit', fontSize: '11px', cursor: 'pointer',
}

/**
 * The fixed right market column. It owns its own instrument and period, so the
 * conversation behind it stays mounted and no layout panel is selected.
 */
export function MarketDrawer({ actions }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(DEFAULT_MARKET_CODE)
  const [code, setCode] = useState(DEFAULT_MARKET_CODE)
  const [period, setPeriod] = useState('day')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const codeRef = useRef(code)
  codeRef.current = code

  useEffect(() => {
    const onRequest = (event) => {
      if (event?.detail?.close === true) {
        setOpen(false)
        return
      }
      const next = drawerTarget(event?.detail?.code, codeRef.current)
      setOpen(true)
      setNotice('')
      setCode(next)
      setQuery(next)
    }
    window.addEventListener(MARKET_DRAWER_EVENT, onRequest)
    return () => window.removeEventListener(MARKET_DRAWER_EVENT, onRequest)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const state = useSnapshot(code, period, open, reload)
  const annotations = useAnnotations(code, open)
  const snapshot = state.phase === 'ready' ? state.snapshot : undefined
  const change = Number(snapshot?.changePercent)
  const changeColor = Number.isFinite(change) ? (change < 0 ? FALLING : RISING) : muted
  const asOf = asOfText(snapshot?.quoteTime)
  const name = clean(snapshot?.name) || code

  const submit = (event) => {
    event.preventDefault()
    const next = normalizeCode(query)
    if (next === '') {
      setNotice('Enter an A-share code such as 600519 or sh600519')
      return
    }
    setNotice('')
    setCode(next)
    setQuery(next)
  }

  const openFullPanel = () => {
    actions?.openPanel?.('market', code)
    setOpen(false)
  }

  if (!open) return null
  return createPortal(h('aside', {
    className: 'bt-market-drawer', role: 'dialog', 'aria-label': 'Market chart',
    'data-code': code, 'data-period': period,
    style: drawer,
  },
  h('div', { style: head },
    h('span', { style: { fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' } }, 'Market'),
    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: muted } }, name),
    h('button', {
      type: 'button', className: 'bt-icon-btn', 'aria-label': 'Close market chart', title: 'Close',
      onClick: () => setOpen(false),
      style: { marginLeft: 'auto', width: '28px', height: '28px', border: 0, borderRadius: '7px', background: 'transparent', color: muted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
    }, h(CloseIcon))),
  h('div', { style: body },
    h('form', { onSubmit: submit, style: row },
      h('input', {
        value: query, onChange: event => { setQuery(event.target.value); if (notice !== '') setNotice('') }, placeholder: '600519 / sh600519',
        'aria-label': 'Instrument code', spellCheck: false, autoComplete: 'off', style: input,
      }),
      h('button', { type: 'submit', style: primary }, 'Open')),
    notice === '' ? null : h('div', { style: { fontSize: '11px', color: 'var(--bt-danger, #e02135)' } }, notice),
    h('div', { role: 'group', 'aria-label': 'Period', style: { display: 'flex', gap: '3px' } },
      PERIODS.map(id => h('button', {
        key: id, type: 'button', 'aria-pressed': id === period, title: id, onClick: () => setPeriod(id),
        style: {
          flex: 1, height: '26px', border: 0, borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontSize: '11px',
          background: id === period ? 'var(--bt-accent, #4d6bfe)' : 'var(--bt-hover, rgba(127, 127, 127, .1))',
          color: id === period ? 'var(--bt-accent-ink, #fff)' : muted,
        },
      }, PERIOD_LABELS[id]))),
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', fontVariantNumeric: 'tabular-nums', minHeight: '26px' } },
      h('span', { style: { fontSize: '22px', fontWeight: 600, lineHeight: '26px', letterSpacing: '-.01em' } }, state.phase === 'loading' && snapshot === undefined ? '—' : priceText(Number(snapshot?.price))),
      h('span', { style: { fontSize: '12px', fontWeight: 600, color: changeColor } }, percentText(change)),
      asOf === '' ? null : h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: faint, whiteSpace: 'nowrap' } }, `as of ${asOf}`)),
    state.phase === 'idle' || state.phase === 'loading' ? h('div', { style: { padding: '24px 0', fontSize: '12px', color: muted } }, 'Loading chart…')
      : state.phase === 'error'
        ? h('div', { style: { padding: '18px 0', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' } },
          h('span', { style: { fontSize: '12px', color: muted } }, 'Chart unavailable'),
          h('span', { style: { fontSize: '11px', color: faint }, title: state.message }, state.message),
          h('button', { type: 'button', style: quiet, onClick: () => setReload(value => value + 1) }, 'Retry'))
        : h(Chart, { snapshot, annotations })),
  h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderTop: '1px solid var(--bt-line, rgba(127, 127, 127, .18))', flex: 'none' } },
    h('span', { style: { fontSize: '10px', color: faint, whiteSpace: 'nowrap' } }, annotations.length > 0 ? `${annotations.length} 项标绘` : 'Agent annotations'),
    h('button', {
      type: 'button', title: 'Close this drawer and open the full market panel', onClick: openFullPanel,
      style: { marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary, #4c7dff)', font: 'inherit', fontSize: '11px', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' },
    }, '打开完整行情中心'))))
}


/** The always-visible entry: a small pill, so the drawer does not depend on a shell slot. */
function MarketPill() {
  return h('button', {
    type: 'button', className: 'bt-market-pill', title: '行情中心', 'aria-label': '行情中心',
    onClick: () => openMarketDrawer(),
    style: {
      position: 'fixed', right: '16px', bottom: '84px', zIndex: 99999,
      height: '34px', padding: '0 13px', border: 0, borderRadius: '999px',
      background: 'var(--bt-accent, #4d6bfe)', color: 'var(--bt-accent-ink, #fff)',
      font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
      boxShadow: '0 6px 18px -6px rgba(0,0,0,.35)',
    },
  }, '行情')
}

/** The pill and the drawer, mounted on their own React root so no shell slot can drop them. */
export function MarketDock({ actions }) {
  return h(Fragment, null, h(MarketPill), h(MarketDrawer, { actions }))
}
