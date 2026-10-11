/**
 * Short-lived read-through cache for the two routes the card polls (#4).
 *
 * The status route queries billing upstream on every GET, and the update route
 * queries npm and GitHub on every GET. Neither route can authenticate its
 * caller — the gate is "Host names loopback", which any local process can
 * write — so without a cache any local process can drive unbounded upstream
 * traffic through this plugin by looping GETs. That is a cost and rate-limit
 * amplifier against the user's own account, and it is the same missing trust
 * boundary the probe-key move addresses.
 *
 * A cache is the honest fix for that half: it bounds the *rate*, which is what
 * an unauthenticated read surface can actually promise. It deliberately does
 * not try to distinguish callers — nothing on this route can.
 *
 * Only fulfilled reads are cached. A rejection is never stored, so a transient
 * failure does not pin an error in front of the user for the whole TTL.
 *
 * @module dsh-workbuddy-connect/route-cache
 */

/** One cached value plus the instant it stops being served. */
interface Entry<T> {
  value: T
  expiresAtMs: number
}

/**
 * Serialize concurrent misses for one key.
 *
 * Without this, N simultaneous first-time requests would each start their own
 * upstream read — the exact fan-out the TTL exists to prevent — and only then
 * populate the cache. Callers arriving during a fill wait for it instead.
 */
export class RouteCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly inflight = new Map<string, Promise<T>>()
  private readonly ttlMs: number
  private readonly now: () => number

  /**
   * @param ttlMs - how long one fulfilled read is served to every caller.
   * @param now - clock seam, so tests need no real delay.
   */
  constructor(ttlMs: number, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
  }

  /**
   * The cached value for \`key\`, or the result of \`load\` when none is fresh.
   *
   * @param key - the cache identity; callers derive it from what the value
   * depends on (the account, the current version), never from the request.
   * @param load - the upstream read to run on a miss.
   */
  async read(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit !== undefined && hit.expiresAtMs > this.now()) return hit.value
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const started = load().then(
      value => {
        this.entries.set(key, { value, expiresAtMs: this.now() + this.ttlMs })
        return value
      },
      (error: unknown) => {
        // Never cached: a failure must not outlive its cause.
        throw error
      },
    ).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, started)
    return started
  }

  /** Drop one key, or every key when none is named. */
  clear(key?: string): void {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }
}
