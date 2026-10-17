import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/team-template.js'

const template = {
  id: 'test-team',
  capabilities: {
    astock: { kind: 'mcp', transport: 'streamable-http', url: 'http://127.0.0.1:50052/mcp', description: 'A股' },
    causal: { kind: 'mcp', transport: 'streamable-http', url: 'http://127.0.0.1:50057/mcp', description: '事件研究' },
  },
  bots: [
    { name: '数据官', role: '数据', instructions: '只给数据。', capabilities: ['astock'] },
    { name: '事件官', role: '事件', instructions: '只给证据。', capabilities: ['causal'] },
  ],
  room: { name: '量化研究组', mode: 'admin', notice: '研究工具，不构成投资建议。' },
}

const makeRuntime = () => {
  const state = {
    version: 1,
    mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief', capabilities: [], createdAt: 1 } },
    rooms: {},
    capabilities: { items: {} },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    revision: 1,
  }
  const calls = []
  const rt = {
    config: {},
    state,
    warn: (...args) => calls.push(['warn', ...args]),
    async load() {},
    async save() { state.revision += 1 },
    botOf: id => state.bots[id],
    async capabilitySave(body) {
      state.capabilities.items[body.name] = { ...body, name: body.name }
      calls.push(['capability', body.name])
      return state.capabilities.items[body.name]
    },
    async changeCapabilityAttachment(_endpoint, { name, bot }, caller) {
      state.bots[bot].capabilities.push(name)
      calls.push(['attach', name, bot, caller])
    },
    async createBot({ name, quiet }) {
      const id = `bot-${Object.keys(state.bots).length}`
      state.bots[id] = { id, name, capabilities: [], createdAt: Date.now() }
      calls.push(['bot', name, quiet])
      return state.bots[id]
    },
    async createRoom({ name, members, mode, notice }) {
      const id = 'room-1'
      state.rooms[id] = { id, name, members, mode, notice }
      calls.push(['room', name])
      return state.rooms[id]
    },
  }
  install(rt)
  return { rt, state, calls }
}

test('seeds capabilities, Bots and one group, then stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-team-'))
  const file = join(dir, 'team.json')
  writeFileSync(file, JSON.stringify(template))
  try {
    const { rt, state, calls } = makeRuntime()
    rt.config.teamTemplate = file
    await rt.ensureTeamTemplate()

    assert.deepEqual(Object.keys(state.capabilities.items).sort(), ['astock', 'causal'])
    assert.deepEqual(state.bots['bot-1'].capabilities, ['astock'])
    assert.deepEqual(state.bots['bot-2'].capabilities, ['causal'])
    assert.equal(calls.filter(([kind]) => kind === 'bot').length, 2)
    assert.ok(calls.filter(([kind]) => kind === 'bot').every(([, , quiet]) => quiet === true))
    assert.equal(state.rooms['room-1'].name, '量化研究组')
    assert.equal(state.teamTemplate.id, 'test-team')

    // A second start must not duplicate anything.
    await rt.ensureTeamTemplate()
    assert.equal(calls.filter(([kind]) => kind === 'bot').length, 2)
    assert.equal(calls.filter(([kind]) => kind === 'capability').length, 2)
    assert.equal(calls.filter(([kind]) => kind === 'room').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown capability fails the seed without marking it done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-team-'))
  const file = join(dir, 'team.json')
  writeFileSync(file, JSON.stringify({ ...template, bots: [{ name: '坏配置', capabilities: ['nope'] }] }))
  try {
    const { rt, state, calls } = makeRuntime()
    rt.config.teamTemplate = file
    await rt.ensureTeamTemplate()
    assert.equal(state.teamTemplate, undefined)
    assert.ok(calls.some(([kind, ...args]) => kind === 'warn' && args.map(String).join(' ').includes('unknown capability')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
