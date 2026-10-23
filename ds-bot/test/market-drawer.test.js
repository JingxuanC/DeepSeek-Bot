import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/market-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})

// Only the pure helpers are exercised here; the component is not rendered.
const react = {
  createElement: () => null,
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useState: initial => [initial, () => {}],
}
const reactDom = { createPortal: () => null }
const loadModule = (CustomEventImpl = CustomEvent) => {
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, CustomEvent: CustomEventImpl,
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return reactDom
      throw new Error(`no platform module ${name}`)
    },
  })
  return module.exports
}
const {
  MARKET_DRAWER_EVENT, DEFAULT_MARKET_CODE, normalizeCode, drawerTarget, periodOf,
  asOfText, annotationModel, mapAnnotations, chartModel, barTick, fitLabel,
  openMarketDrawer, closeMarketDrawer,
} = loadModule()
// Values made inside the vm sandbox carry another realm's prototypes.
const plain = value => JSON.parse(JSON.stringify(value))

test('codes accept every A-share spelling and normalise to the market-center vocabulary', () => {
  assert.equal(normalizeCode('600519'), 'sh600519')
  assert.equal(normalizeCode('sh600519'), 'sh600519')
  assert.equal(normalizeCode(' SH600519 '), 'sh600519')
  assert.equal(normalizeCode('600519.SH'), 'sh600519')
  assert.equal(normalizeCode('600519.ss'), 'sh600519')
  assert.equal(normalizeCode('000001.sz'), 'sz000001')
  assert.equal(normalizeCode('300750'), 'sz300750')
  assert.equal(normalizeCode('830799'), 'bj830799')
  assert.equal(normalizeCode('900901'), '')
  assert.equal(normalizeCode('AAPL'), '')
  assert.equal(normalizeCode(''), '')
  assert.equal(normalizeCode(undefined), '')
})

test('a request without a code keeps the current instrument, else the default', () => {
  assert.equal(drawerTarget('600519', 'sz000001'), 'sh600519')
  assert.equal(drawerTarget(null, 'sz000001'), 'sz000001')
  assert.equal(drawerTarget('', ''), DEFAULT_MARKET_CODE)
  assert.equal(drawerTarget('not-a-code', 'sh600000'), 'sh600000')
})

test('periods validate and the quote stamp renders as readable market time', () => {
  assert.equal(periodOf('5min'), '5min')
  assert.equal(periodOf('month'), 'month')
  assert.equal(periodOf('1h'), 'day')
  assert.equal(periodOf(undefined), 'day')
  assert.equal(asOfText('20261016161447'), '2026-10-16 16:14:47')
  assert.equal(asOfText('2026-10-16'), '')
})

test('drawing labels fit the chart gutter and announce truncation', () => {
  assert.equal(fitLabel('600519', 80, 10), '600519')
  assert.equal(fitLabel('支撑位', 80, 10), '支撑位')
  assert.match(fitLabel('压力① 1363.4 60日高', 32, 10), /…$/)
  assert.equal(fitLabel('', 32, 10), '')
})

test('the drawer opens and closes through one window event', () => {
  const sent = []
  const target = { dispatchEvent: event => sent.push(event) }
  openMarketDrawer('600519', target)
  closeMarketDrawer(target)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].type, MARKET_DRAWER_EVENT)
  assert.equal(sent[0].detail.code, '600519')
  assert.equal(sent[1].type, MARKET_DRAWER_EVENT)
  assert.equal(sent[1].detail.close, true)
  openMarketDrawer(undefined, target)
  assert.equal(sent[2].detail.code, null)
})

test('annotations map levels and only the markers whose trading day is visible', () => {
  const bars = [{ time: '2026-09-28', close: 1228 }, { time: '2026-10-16', close: 1329 }]
  const entries = [
    { kind: 'price-line', price: '1300', label: '支撑', color: '#30a46c', style: 'dashed' },
    { kind: 'price-line', price: 'not-a-price', label: 'bad' },
    { kind: 'price-line', price: 1360, label: '压力', style: 'unknown' },
    { kind: 'marker', time: '2026-09-28', label: '阶段低点', position: 'belowBar', color: '#4c7dff' },
    { kind: 'marker', time: '2026-01-01', label: '窗口外' },
    { kind: 'note', time: '2026-10-16', label: 'ignored' },
  ]
  const model = annotationModel(entries)
  assert.equal(model.priceLines.length, 2)
  assert.deepEqual(plain(model.priceLines[0]), { price: 1300, label: '支撑', color: '#30a46c', style: 'dashed' })
  assert.equal(model.priceLines[1].style, 'solid')
  assert.equal(model.markers.length, 2)

  const mapped = mapAnnotations(entries, bars)
  assert.equal(mapped.markers.length, 1)
  assert.equal(mapped.markers[0].index, 0)
  assert.equal(mapped.markers[0].label, '阶段低点')
})

test('candles use OHLC, are coloured by close against open, and keep levels in range', () => {
  const bars = [
    { time: '2026-09-28', open: 1228, high: 1240, low: 1220, close: 1236 },
    { time: '2026-10-16', open: 1300, high: 1330, low: 1290, close: 1329 },
  ]
  const model = chartModel(bars, [
    { kind: 'price-line', price: 1360, label: '压力' },
    { kind: 'marker', time: '2026-10-16', label: '高点', position: 'aboveBar' },
  ])
  assert.equal(model.candles.length, 2)
  assert.equal(model.candles[0].up, true)
  assert.equal(model.candles[1].up, true)
  for (const candle of model.candles) {
    assert.ok(candle.yHigh <= candle.yLow)
    assert.ok(Number.isFinite(candle.x))
  }
  // The level beyond the highs widens the range so its line stays on the canvas.
  assert.ok(model.max > 1360)
  assert.equal(model.priceLines.length, 1)
  assert.ok(model.priceLines[0].y < model.candles[1].yClose)
  assert.equal(model.markers.length, 1)
  assert.equal(model.markers[0].index, 1)
  assert.equal(chartModel([{ time: '2026-09-28', close: 1 }], []).candles.length, 0)
  assert.equal(barTick('2026-10-16'), '10-16')
  assert.match(barTick(1792133400), /^\d{2}-\d{2} \d{2}:\d{2}$/)
})
