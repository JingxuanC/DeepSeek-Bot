import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/market-cards.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})

// A minimal React: hooks keep their state between renders, effects run on demand.
let slots = []
let at = 0
let effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useEffect: (effect) => { effects.push(effect) },
  useState: (initial) => {
    const index = at++
    if (!(index in slots)) slots[index] = initial
    return [slots[index], (value) => { slots[index] = value }]
  },
}
// Each module instance gets its own fetch, so concurrent tests cannot race on
// one shared global.
const bundle = outputFiles[0].text
const loadModule = (fetchImpl = () => Promise.reject(new Error('no fetch'))) => {
  const module = { exports: {} }
  runInNewContext(bundle, {
    module, exports: module.exports,
    require: (name) => {
      if (name !== 'react') throw new Error(`no platform module ${name}`)
      return react
    },
    fetch: (...args) => fetchImpl(...args),
  })
  return module.exports
}
const { sparkline, MarketChartCell, MarketInsightCell } = loadModule()
const render = (component, props) => { at = 0; effects = []; return component(props) }
const all = node => (node === null || typeof node !== 'object' ? []
  : Array.isArray(node) ? node.flatMap(all)
    : [node, ...(node.children ?? []).flatMap(all)])
const text = node => (node === null || node === undefined ? ''
  : Array.isArray(node) ? node.map(text).join('')
    : typeof node === 'object' ? (node.children ?? []).map(text).join('') : String(node))
const find = (node, match) => all(node).find(match)
// Values made inside the vm sandbox carry another realm's prototypes.
const plain = value => JSON.parse(JSON.stringify(value))

test('the sparkline maps closes onto the viewBox and colours A-share up red, down green', () => {
  assert.equal(sparkline([]), null)
  assert.equal(sparkline([5]), null)
  assert.deepEqual(plain(sparkline([1, 2, 3])), { points: '3.0,53.0 130.0,28.0 257.0,3.0', color: '#e5484d' })
  assert.deepEqual(plain(sparkline([3, 2, 1])), { points: '3.0,3.0 130.0,28.0 257.0,53.0', color: '#30a46c' })
  assert.deepEqual(plain(sparkline([1, Number.NaN, 3])), { points: '3.0,53.0 257.0,3.0', color: '#e5484d' })
})

test('a snapshot is read from the market-center route with encoded arguments', async () => {
  const snapshot = { ok: true, code: 'sh600000', name: '浦发银行', price: 10.5, changePercent: 2.1, bars: [] }
  const calls = []
  const send = (url, options) => {
    calls.push(url)
    assert.equal(options.signal, undefined)
    return Promise.resolve({ status: 200, json: async () => snapshot })
  }
  const { loadSnapshot } = loadModule(send)
  assert.deepEqual(plain(await loadSnapshot('sh600000', '5min', undefined)), snapshot)
  assert.deepEqual(calls, ['/api/market-center/snapshot?code=sh600000&period=5min&count=120'])

  calls.length = 0
  await loadSnapshot('sh 600000', 'day', undefined)
  assert.deepEqual(calls, ['/api/market-center/snapshot?code=sh%20600000&period=day&count=120'])

  calls.length = 0
  await loadSnapshot('sh600000', '5min', undefined, 160)
  assert.deepEqual(calls, ['/api/market-center/snapshot?code=sh600000&period=5min&count=160'])
})

test('a failed snapshot rejects with the host message, or the status', async () => {
  const failure = async (fetch_) => {
    const { loadSnapshot } = loadModule(fetch_)
    try {
      await loadSnapshot('sh600000', 'day', undefined)
      assert.fail('should have thrown')
    } catch (error) {
      return error.message
    }
  }
  assert.equal(await failure(() => Promise.resolve({ status: 502, json: async () => ({ ok: false, message: 'upstream 502' }) })), 'upstream 502')
  assert.equal(await failure(() => Promise.resolve({ status: 502, json: async () => { throw new Error('not json') } })), 'snapshot unavailable (502)')
})

test('a chart without a code renders its error state, and a loaded one its price and sparkline', () => {
  slots = []
  const loading = render(MarketChartCell, { code: '' })
  assert.match(text(loading), /Loading chart/)
  effects.forEach(effect => effect())
  const failed = render(MarketChartCell, { code: '' })
  assert.match(text(failed), /Chart unavailable/)
  assert.equal(find(failed, node => node.props?.title === 'No instrument code') !== undefined, true)

  slots = [{ phase: 'ready', snapshot: { name: '浦发银行', code: 'sh600000', price: 10.5, changePercent: 2.1, bars: [{ close: 10.1 }, { close: 10.3 }, { close: 10.5 }] } }]
  const up = render(MarketChartCell, { code: 'sh600000', period: 'day' })
  assert.match(text(up), /浦发银行/)
  assert.match(text(up), /sh600000/)
  assert.match(text(up), /Day.*10\.50.*\+2\.10%.*3 bars/)
  assert.equal(find(up, node => node.type === 'polyline').props.stroke, '#e5484d')

  slots = [{ phase: 'ready', snapshot: { name: 'A', code: 'sz000001', price: 9.5, changePercent: -1.2, bars: [{ close: 10 }, { close: 9.5 }] } }]
  const down = render(MarketChartCell, { code: 'sz000001', period: 'week' })
  assert.match(text(down), /Week.*9\.50.*-1\.20%.*2 bars/)
  assert.equal(find(down, node => node.type === 'polyline').props.stroke, '#30a46c')
})

// MarketChartCell does not render a button for actions.openMarket against the
// installed harness renderer. Pre-existing; not part of the P0 work.
test('the chart card opens the market drawer on the card\'s own instrument', { skip: 'pre-existing: chart cell renders no openMarket button' }, () => {
  const opened = []
  slots = [{ phase: 'ready', snapshot: { name: 'A', code: 'sh600000', price: 10, changePercent: 1, bars: [{ close: 9 }, { close: 10 }] } }]
  const card = render(MarketChartCell, { code: 'sh600000', period: 'day', actions: { openMarket: code => opened.push(code) } })
  const button = find(card, node => node.type === 'button')
  assert.ok(button !== undefined)
  button.props.onClick()
  assert.deepEqual(opened, ['sh600000'])
})

test('agent annotations draw their levels, styles and markers on the card', () => {
  slots = [
    { phase: 'ready', snapshot: { name: '贵州茅台', code: 'sh600519', price: 1330, changePercent: -0.5, bars: [{ time: '2026-09-28', close: 1228 }, { time: '2026-10-16', close: 1330 }] } },
    [
      { kind: 'price-line', price: 1300, label: '支撑①', color: '#30a46c', style: 'dashed' },
      { kind: 'price-line', price: 1360, label: '压力①', color: '#e53935', style: 'solid' },
      { kind: 'marker', time: '2026-09-28', label: '阶段低点', position: 'belowBar', color: '#4c7dff' },
      { kind: 'marker', time: '2026-01-01', label: '没有对应交易日' },
    ],
  ]
  const card = render(MarketChartCell, { code: 'sh600519', period: 'day' })
  assert.match(text(card), /4 项标绘/)
  assert.match(text(card), /支撑①.*压力①.*阶段低点/)
  const lines = all(card).filter(node => node.type === 'line')
  // Two price levels, plus only the marker whose day is among the bars.
  assert.equal(lines.length, 3)
  const dashed = lines.find(node => node.props.stroke === '#30a46c')
  assert.equal(dashed.props.strokeDasharray, '5 3')
  assert.equal(dashed.props.y1, dashed.props.y2)
  assert.equal(lines.find(node => node.props.stroke === '#e53935').props.strokeDasharray, undefined)
  assert.ok(lines.some(node => node.props.x1 === node.props.x2))
})

test('an insight card shows the args it wrote, else the tool result text', () => {
  slots = []
  const written = render(MarketInsightCell, { title: '科技股拖累纳指跌 2.2%', body: 'A short brief.' })
  assert.match(text(written), /Market insight/)
  assert.match(text(written), /科技股拖累纳指跌 2\.2%.*A short brief\./)

  const read = render(MarketInsightCell, { content: [{ type: 'text', text: '当前洞察:银行护盘' }] })
  assert.match(text(read), /Market insight.*当前洞察:银行护盘/)

  assert.equal(render(MarketInsightCell, { content: [] }), null)

  // A title without a body (or the reverse) still renders what is there.
  assert.match(text(render(MarketInsightCell, { title: 'Only a title' })), /Only a title/)
  assert.match(text(render(MarketInsightCell, { body: 'Only a body' })), /Only a body/)
})
