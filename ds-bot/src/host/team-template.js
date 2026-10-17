// Team payload: seed a whole Bot team — Bots, capabilities, skills, memory and one
// group chat — from a directory or a JSON file, once, on the first start where
// `config.teamBundle` (a directory) or `config.teamTemplate` (a JSON file) is set.
//
// The public repository carries only the LOADER and an example payload. A paid team
// ships its own directory: `team.json`, `skills/<name>/SKILL.md`, and
// `memory/team|bots/<key>/MEMORY.md`. Nothing here knows what is in that payload.
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_BOTS = 24
const MEMORY_MAIN_MAX = 4_000

export function install(rt) {
  const { config } = rt
  let running = null

  const payloadOf = () => {
    const bundle = config.teamBundle
    if (typeof bundle === 'string' && bundle.trim() !== '') {
      const dir = isAbsolute(bundle) ? bundle : resolve(process.cwd(), bundle)
      return { dir, manifest: join(dir, 'team.json'), setting: bundle }
    }
    const file = config.teamTemplate
    if (typeof file !== 'string' || file.trim() === '') return undefined
    const manifest = isAbsolute(file) ? file : resolve(process.cwd(), file)
    return { dir: dirname(manifest), manifest, setting: file }
  }

  // Runs at most once per process; a failure is logged and retried on the next
  // start (the state marker is written only after every step succeeded).
  async function ensureTeamTemplate() {
    if (running !== null) return running
    const payload = payloadOf()
    if (payload === undefined) return
    running = seed(payload)
      .catch(error => {
        rt.warn('ds-bot: team payload %s failed: %s', payload.setting, error)
        return undefined
      })
      .finally(() => { running = null })
    return running
  }

  async function seed({ dir, manifest }) {
    const template = JSON.parse(await readFile(manifest, 'utf8'))
    if (template === null || typeof template !== 'object' || Array.isArray(template)) {
      throw new Error('team.json must be a JSON object')
    }
    const id = String(template.id ?? manifest)
    await rt.load()
    if (rt.state.teamTemplate?.id === id) return

    const chief = rt.botOf(rt.state.mainBotIds[0])
    if (chief === undefined) throw new Error('there is no Main Bot to lead the team')

    // Skills first: a Bot spec may attach them by name together with MCP servers.
    const skills = await readSkills(dir)
    for (const [name, spec] of Object.entries(skills)) {
      if (rt.state.capabilities.items[name] !== undefined) continue
      await rt.capabilitySave({ name, ...spec }, { ui: true })
    }

    const capabilities = template.capabilities ?? {}
    for (const [name, spec] of Object.entries(capabilities)) {
      if (!NAME.test(name)) throw new Error(`capability name ${name} is invalid`)
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error(`capability ${name} must be an object`)
      }
      // A capability that already exists is left alone: the user may have edited
      // or attached it, and re-seeding must not undo that.
      if (rt.state.capabilities.items[name] !== undefined) continue
      await rt.capabilitySave({ name, ...spec }, { ui: true })
    }

    const bots = []
    const byKey = new Map()
    const specs = Array.isArray(template.bots) ? template.bots : []
    if (specs.length > MAX_BOTS) throw new Error(`a payload may seed at most ${MAX_BOTS} Bots`)
    for (const spec of specs) {
      const name = String(spec?.name ?? '').trim()
      if (name === '') continue
      const key = String(spec.key ?? name).trim()
      if (byKey.has(key)) throw new Error(`two Bots share the key ${key}`)
      let bot = Object.values(rt.state.bots).find(existing => existing.name === name)
      if (bot === undefined) {
        bot = await rt.createBot({
          name,
          role: String(spec.role ?? ''),
          instructions: String(spec.instructions ?? ''),
          brief: String(spec.brief ?? ''),
          quiet: true,
          ...(spec.model === undefined ? {} : { model: String(spec.model) }),
          ...(spec.workDir === undefined ? {} : { workDir: String(spec.workDir) }),
        })
      }
      const attach = [...(spec.capabilities ?? []), ...(spec.skills ?? [])]
      for (const capability of attach) {
        if (rt.state.capabilities.items[capability] === undefined) {
          throw new Error(`Bot ${name} names an unknown capability ${capability}`)
        }
        if (!(bot.capabilities ?? []).includes(capability)) {
          await rt.changeCapabilityAttachment('attach', { name: capability, bot: bot.id }, chief.id)
        }
      }
      byKey.set(key, bot)
      bots.push(bot)
    }

    let room
    const roomSpec = template.room
    if (roomSpec !== undefined) {
      const roomName = String(roomSpec.name ?? '').trim()
      room = Object.values(rt.state.rooms).find(existing => existing.name === roomName)
      if (room === undefined && roomName !== '') {
        room = await rt.createRoom({
          name: roomName,
          members: [chief.id, ...bots.map(bot => bot.id)],
          notice: String(roomSpec.notice ?? ''),
          ...(roomSpec.mode === 'everyone' ? { mode: 'everyone' } : {}),
          admin: chief.id,
          createdBy: chief.id,
        })
      }
    }

    await seedMemory(rt, dir, byKey)

    rt.state.teamTemplate = {
      id,
      bundle: dir,
      bots: bots.map(bot => bot.id),
      room: room?.id,
      seededAt: Date.now(),
    }
    await rt.save()
    return rt.state.teamTemplate
  }

  rt.ensureTeamTemplate = ensureTeamTemplate
}

// ---------------------------------------------------------------------------
// Payload parts

// One `skills/<name>/SKILL.md` per skill: the frontmatter names it, the body is
// what the model reads. A malformed skill fails the seed instead of being skipped.
async function readSkills(dir) {
  const root = join(dir, 'skills')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  const skills = {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(error => {
      throw new Error(`skill ${entry.name}: ${error.message}`)
    })
    const parsed = parseSkill(text, entry.name)
    if (!NAME.test(parsed.name)) throw new Error(`skill name ${parsed.name} is invalid`)
    if (skills[parsed.name] !== undefined) throw new Error(`two skills are named ${parsed.name}`)
    skills[parsed.name] = { kind: 'skill', description: parsed.description, content: parsed.content }
  }
  return skills
}

export function parseSkill(text, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const meta = {}
  let body = text
  if (match !== null) {
    body = text.slice(match[0].length)
    for (const line of match[1].split(/\r?\n/)) {
      const found = /^(name|description):\s*(.*)$/.exec(line.trim())
      if (found !== null) meta[found[1]] = unquoteScalar(found[2])
    }
  }
  return {
    name: String(meta.name ?? fallbackName).trim(),
    description: String(meta.description ?? '').trim(),
    content: body.trim(),
  }
}

const unquoteScalar = value => {
  const text = String(value).trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

// Copies the payload's starter memory into the team's own memory store. Nothing is
// overwritten unless `config.overwriteMemory` is true: the user's later memory wins.
async function seedMemory(rt, dir, byKey) {
  const root = join(dir, 'memory')
  if (!(await exists(root))) return
  if (typeof rt.home !== 'string' || rt.home === '') return
  const memoryHome = join(rt.home, 'memory')
  const overwrite = rt.config?.overwriteMemory === true

  await copyIfAbsent(join(root, 'team', 'MEMORY.md'), join(memoryHome, 'team', 'MEMORY.md'), overwrite)
  for (const [key, bot] of byKey) {
    const source = join(root, 'bots', key)
    if (!(await exists(source))) continue
    let entries
    try {
      entries = await readdir(source, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      await copyIfAbsent(join(source, entry.name), join(memoryHome, 'bots', bot.id, entry.name), overwrite)
    }
  }
}

async function copyIfAbsent(source, target, overwrite) {
  if (!overwrite && await exists(target)) return
  await mkdir(dirname(target), { recursive: true })
  if (target.endsWith('MEMORY.md')) {
    const text = await readFile(source, 'utf8')
    // The memory module enforces the same ceiling; a payload over it would be
    // trimmed silently at the next write, so refuse it here instead.
    if (text.length > MEMORY_MAIN_MAX) throw new Error(`${source} is over the ${MEMORY_MAIN_MAX}-character MEMORY.md limit`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return
  }
  await copyFile(source, target)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
