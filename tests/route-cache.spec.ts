import { describe, expect, it, vi } from 'vitest'
import { RouteCache } from '../src/route-cache.ts'

/**
 * Issue #4: the status and update routes cannot authenticate their caller —
 * their gate accepts any request that claims a loopback Host — so the only
 * thing they can promise an unauthenticated reader is a bounded *rate*. These
 * tests pin the TTL, the miss-coalescing, and the rule that a failure is never
 * cached.
 */
describe('RouteCache', () => {
  /** A clock the test advances by hand, so no test waits on real time. */
  function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
    let value = start
    return { now: () => value, advance: (ms: number) => { value += ms } }
  }

  it('serves one fulfilled load to every caller inside the TTL', async () => {
    const time = clock()
    const cache = new RouteCache<number>(1_000, time.now)
    const load = vi.fn(async () => 42)

    expect(await cache.read('k', load)).toBe(42)
    time.advance(999)
    expect(await cache.read('k', load)).toBe(42)
    // One upstream read for three callers: that is the whole point.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads once the TTL has passed', async () => {
    const time = clock()
    const cache = new RouteCache<number>(1_000, time.now)
    let value = 1
    const load = vi.fn(async () => value)

    expect(await cache.read('k', load)).toBe(1)
    value = 2
    // Exactly at the deadline the entry is no longer fresh.
    time.advance(1_000)
    expect(await cache.read('k', load)).toBe(2)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keys entries independently', async () => {
    const time = clock()
    const cache = new RouteCache<string>(1_000, time.now)
    const first = vi.fn(async () => 'a')
    const second = vi.fn(async () => 'b')

    expect(await cache.read('account-a', first)).toBe('a')
    expect(await cache.read('account-b', second)).toBe('b')
    // A different key must not answer from another key's entry — this is what
    // stops an account switch from serving the previous account's balance.
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent misses into one load', async () => {
    const time = clock()
    const cache = new RouteCache<number>(1_000, time.now)
    let release: ((value: number) => void) | undefined
    const load = vi.fn(() => new Promise<number>(resolve => { release = resolve }))

    const pending = [cache.read('k', load), cache.read('k', load), cache.read('k', load)]
    release!(7)
    expect(await Promise.all(pending)).toEqual([7, 7, 7])
    // Without coalescing, three simultaneous first-time requests would each
    // start their own upstream read — the fan-out the TTL exists to prevent.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('never caches a rejection', async () => {
    const time = clock()
    const cache = new RouteCache<number>(1_000, time.now)
    const failing = vi.fn(async () => { throw new Error('upstream down') })
    const ok = vi.fn(async () => 5)

    await expect(cache.read('k', failing)).rejects.toThrow('upstream down')
    // A transient failure must not pin an error in front of the user for the
    // rest of the TTL: the very next call goes upstream again.
    expect(await cache.read('k', ok)).toBe(5)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('lets a failed in-flight load be retried rather than remembered', async () => {
    const time = clock()
    const cache = new RouteCache<number>(1_000, time.now)
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('first fails')
      return 9
    })

    const first = cache.read('k', load)
    const second = cache.read('k', load) // shares the in-flight failure
    await expect(first).rejects.toThrow('first fails')
    await expect(second).rejects.toThrow('first fails')
    expect(await cache.read('k', load)).toBe(9)
  })

  it('clears one key or all of them', async () => {
    const time = clock()
    const cache = new RouteCache<number>(60_000, time.now)
    expect(await cache.read('a', async () => 1)).toBe(1)
    expect(await cache.read('b', async () => 2)).toBe(2)

    cache.clear('a')
    expect(await cache.read('a', async () => 10)).toBe(10)
    expect(await cache.read('b', async () => 20)).toBe(2)

    cache.clear()
    expect(await cache.read('b', async () => 20)).toBe(20)
  })
})
