// One-shot waiters for the next turn/end on a Bot session.
// `skip` drops turns that were already running when the waiter was registered.

export function createTurnWaiters() {
  /** @type {Map<string, Set<{ skip: number, timer: NodeJS.Timeout, resolve: (value: object) => void }>>} */
  const pending = new Map()

  function drop(sessionId, waiter) {
    const set = pending.get(sessionId)
    if (!set) return
    set.delete(waiter)
    if (set.size === 0) pending.delete(sessionId)
  }

  function awaitNext(sessionId, timeoutMs, { skip = 0 } = {}) {
    let waiter
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        drop(sessionId, waiter)
        resolve({ ok: false, text: '', error_kind: 'timeout', reason: 'timeout' })
      }, timeoutMs)
      waiter = {
        skip,
        timer,
        resolve: (value) => {
          clearTimeout(timer)
          drop(sessionId, waiter)
          resolve(value)
        },
      }
      const set = pending.get(sessionId) ?? new Set()
      set.add(waiter)
      pending.set(sessionId, set)
    })
    promise.cancel = () => waiter.resolve({ ok: false, text: '', error_kind: 'cancelled', reason: 'cancelled' })
    return promise
  }

  function notify(sessionId, payload) {
    const set = pending.get(sessionId)
    if (!set) return
    for (const waiter of [...set]) {
      if (waiter.skip > 0) {
        waiter.skip -= 1
        continue
      }
      waiter.resolve(payload)
    }
  }

  function cancel(sessionId) {
    const set = pending.get(sessionId)
    if (!set) return
    for (const waiter of [...set]) {
      waiter.resolve({ ok: false, text: '', error_kind: 'cancelled', reason: 'cancelled' })
    }
  }

  return { awaitNext, notify, cancel }
}
