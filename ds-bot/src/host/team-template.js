// Team template: seed a whole Bot team (Bots, capabilities, one group chat) from a
// JSON file, once, on the first start where `config.teamTemplate` is set.
//
// The module knows only the TEMPLATE SHAPE, never the paid content: a shipped team
// is a private JSON file, while the public repo carries an example. Seeding uses the
// same roster/capability/room functions the UI uses, so names, ownership and the
// first-run Main Bot rules stay in one place.
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_BOTS = 24

export function install(rt) {
  const { config } = rt
  let running = null

  const templatePath = () => {
    const file = config.teamTemplate
    if (typeof file !== 'string' || file.trim() === '') return undefined
    return isAbsolute(file) ? file : resolve(process.cwd(), file)
  }

  // Runs at most once per process; a failure is logged and retried on the next
  // start (the state marker is written only after every step succeeded).
  async function ensureTeamTemplate() {
    if (running !== null) return running
    const file = templatePath()
    if (file === undefined) return
    running = seed(file)
      .catch(error => {
        rt.warn('ds-bot: team template %s failed: %s', file, error)
        return undefined
      })
      .finally(() => { running = null })
    return running
  }

  async function seed(file) {
    const raw = await readFile(file, 'utf8')
    const template = JSON.parse(raw)
    if (template === null || typeof template !== 'object' || Array.isArray(template)) {
      throw new Error('the template must be a JSON object')
    }
    const id = String(template.id ?? file)
    await rt.load()
    if (rt.state.teamTemplate?.id === id) return

    const chief = rt.botOf(rt.state.mainBotIds[0])
    if (chief === undefined) throw new Error('there is no Main Bot to lead the team')

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
    const specs = Array.isArray(template.bots) ? template.bots : []
    if (specs.length > MAX_BOTS) throw new Error(`a template may seed at most ${MAX_BOTS} Bots`)
    for (const spec of specs) {
      const name = String(spec?.name ?? '').trim()
      if (name === '') continue
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
      for (const capability of spec.capabilities ?? []) {
        if (rt.state.capabilities.items[capability] === undefined) {
          throw new Error(`Bot ${name} names an unknown capability ${capability}`)
        }
        if (!(bot.capabilities ?? []).includes(capability)) {
          await rt.changeCapabilityAttachment('attach', { name: capability, bot: bot.id }, chief.id)
        }
      }
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

    rt.state.teamTemplate = {
      id,
      file,
      bots: bots.map(bot => bot.id),
      room: room?.id,
      seededAt: Date.now(),
    }
    await rt.save()
    return rt.state.teamTemplate
  }

  rt.ensureTeamTemplate = ensureTeamTemplate
}
