import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { classifyUpstreamError, extractDisplayErrorMessage, normalizeCredits, parseModelCatalog, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Offline unit tests for WorkBuddyUpstreamClient, mocking the global `fetch`
 * so the multi-layer response parsing and the credit-remain selection logic in
 * `fetchCredits` are covered without a real account or network. This closes a
 * gap that previously relied solely on `scripts/live-e2e.mjs`.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** Build the nested upstream billing document that `fetchCredits` unwraps. */
function billingEnvelope(accounts: unknown[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      Response: {
        Data: {
          Accounts: accounts,
        },
      },
    },
  })
}

/** Minimal Response-like object satisfying `readEnvelope` (which calls `.text()`). */
function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  /** Build the models-catalog envelope that `fetchModels` unwraps. */
  function modelsEnvelope(models: unknown[], cliIds: string[]): string {
    return JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models,
        agents: [{ name: 'cli', models: cliIds }],
      },
    })
  }

  it('propagates supportsImages per model, treating unknown or disabled as text-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-img', name: 'Image Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
      { id: 'm-muted', name: 'Multimodal Switched Off', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true, disabledMultimodal: true },
      { id: 'm-text', name: 'Text Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: false },
      { id: 'm-unknown', name: 'No Modality Field', maxInputTokens: 100_000, maxOutputTokens: 32_000 },
      { id: 'm-noncli', name: 'Not A CLI Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-img', 'm-muted', 'm-text', 'm-unknown']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(models).toHaveLength(4)
    expect(byId.get('m-img')?.supportsImages).toBe(true)
    expect(byId.get('m-muted')?.supportsImages).toBe(false)
    expect(byId.get('m-text')?.supportsImages).toBe(false)
    // Absent field means unknown capability; the conservative answer is text-only.
    expect(byId.get('m-unknown')?.supportsImages).toBe(false)
  })

  it('keeps the catalog shape (name, contextWindow, maxTokens) alongside the flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-1', name: 'Model One', maxInputTokens: 168_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-1']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'm-1',
      name: 'Model One',
      contextWindow: 168_000,
      maxTokens: 32_000,
      supportsImages: true,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
      billing: { free: false },
    })
  })

  it('parses reasoning and billing metadata from the upstream fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      {
        id: 'm-reason',
        name: 'Reasoner',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        reasoning: { supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true },
      },
      {
        id: 'm-free',
        name: 'Freebie',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        onlyReasoning: true,
        reasoning: { canDisableThinking: false },
        credits: 'x0.00',
        tags: ['craft', 'badge:限时免费:#FF0000'],
      },
      {
        id: 'm-plain',
        name: 'Plain',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
      },
    ], ['m-reason', 'm-free', 'm-plain']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(byId.get('m-reason')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: false,
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(byId.get('m-free')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
    })
    expect(byId.get('m-free')?.billing).toEqual({ credits: 'x0.00', badges: ['限时免费'], free: true })
    // A model with no reasoning or billing fields is explicitly non-reasoning
    // (supports: false) and carries no free/badge facts.
    expect(byId.get('m-plain')?.reasoning).toEqual({
      supports: false,
      onlyReasoning: false,
      canDisableThinking: true,
    })
    expect(byId.get('m-plain')?.billing).toEqual({ free: false })
  })

  it('judges `free` from the normalized multiplier, so `x0.00 credits` counts as free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-suffix', name: 'Suffixed', maxInputTokens: 100_000, maxOutputTokens: 32_000, credits: 'x0.00 credits' },
      { id: 'm-paid-suffix', name: 'Paid Suffixed', maxInputTokens: 100_000, maxOutputTokens: 32_000, credits: 'x0.79 credits' },
    ], ['m-suffix', 'm-paid-suffix']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('m-suffix')?.billing).toEqual({ credits: 'x0.00 credits', free: true })
    expect(byId.get('m-paid-suffix')?.billing).toEqual({ credits: 'x0.79 credits', free: false })
  })
})

describe('WorkBuddyUpstreamClient.fetchCredits', () => {
  it('unwraps the nested envelope and aggregates total across accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg-a', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      { PackageName: 'pkg-b', CycleCapacitySize: 200, CycleCapacityRemain: 60 },
    ]))))

    const client = new WorkBuddyUpstreamClient()
    const credits = await client.fetchCredits(CREDENTIAL)

    expect(credits.total).toBe(100)
    expect(credits.accounts).toHaveLength(2)
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg-a', remain: 40, size: 100 })
    expect(credits.accounts[1]).toEqual({ packageName: 'pkg-b', remain: 60, size: 200 })
  })

  it('selects cycle remain when size > 0 (first branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 30, CapacityRemain: 999 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // First branch: size>0 → cycleRemain, ignoring the larger CapacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 30, size: 100 })
  })

  it('selects cycle remain when there is cycle usage even without size (second branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 0, CycleCapacityRemain: 20, CycleCapacityUsed: 5, CapacityRemain: 1 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Second branch: size<=0 but cycleUsed>0 → cycleRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 20, size: 0 })
  })

  it('falls back to capacity remain when no cycle fields (third branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacityRemain: 77 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Third branch: no size, no cycle → capacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 77, size: 0 })
  })

  it('clamps a negative remain to zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: -50 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.remain).toBe(0)
    expect(credits.total).toBe(0)
  })

  it('falls back to CapacitySize for size when cycle size is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacitySize: 500, CapacityRemain: 120 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // size falls back to CapacitySize=500; remain from third branch = 120.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 120, size: 500 })
  })

  it('labels a missing package name as (unnamed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { CycleCapacitySize: 10, CycleCapacityRemain: 5 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.packageName).toBe('(unnamed)')
  })

  it('returns an empty list for an empty Accounts array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([])
  })

  it('skips non-object account entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      null,
      'not-an-object',
      42,
      { PackageName: 'valid', CycleCapacitySize: 10, CycleCapacityRemain: 7 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.accounts[0]!.packageName).toBe('valid')
  })

  /**
   * Expiry coverage. The upstream has always sent `CycleEndTime`; these pin the
   * parsing, the bucketing, and — importantly — the two states that must not be
   * confused: "no end times reported" versus "nothing expiring".
   */
  describe('package expiry', () => {
    /** A local-time stamp the same shape the upstream sends. */
    const at = (offsetMs: number): string => {
      const d = new Date(Date.now() + offsetMs)
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    const HOUR = 3600 * 1000
    const DAY = 24 * HOUR

    it('reads CycleEndTime into endTimeMs', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40, CycleEndTime: at(2 * DAY) },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      const end = credits.accounts[0]!.endTimeMs
      expect(end).toBeTypeOf('number')
      // Same wall-clock moment, to the second.
      expect(Math.abs((end ?? 0) - (Date.now() + 2 * DAY))).toBeLessThan(2000)
    })

    it('omits endTimeMs for an absent or malformed stamp', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'no-field', CycleCapacitySize: 10, CycleCapacityRemain: 5 },
        { PackageName: 'empty', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '' },
        { PackageName: 'garbage', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: 'whenever' },
        { PackageName: 'numeric', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: 1791678478000 },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      // A malformed stamp must read as "unknown", never as "never expires".
      for (const account of credits.accounts) expect(account.endTimeMs).toBeUndefined()
    })

    it('reports no expiry summary when the upstream sent no end times', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      // Absence of data is not evidence of safety, so the field stays unset.
      expect(credits.expiry).toBeUndefined()
    })

    it('omits endTimeMs for a stamp that is not a real calendar moment', async () => {
      // `Date` rolls overflowing fields forward instead of rejecting them, so a
      // shape-valid but impossible stamp would otherwise be read as a confident
      // nearby date. Every one of these must come back as "unknown".
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'non-leap', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-02-29 10:00:00' },
        { PackageName: 'feb-30', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-02-30 10:00:00' },
        { PackageName: 'month-13', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-13-01 10:00:00' },
        { PackageName: 'month-00', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-00-15 10:00:00' },
        { PackageName: 'apr-31', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-04-31 10:00:00' },
        { PackageName: 'hour-25', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-01-01 25:00:00' },
        { PackageName: 'minute-60', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-01-01 10:60:00' },
        { PackageName: 'second-99', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2026-01-01 10:00:99' },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      for (const account of credits.accounts) expect(account.endTimeMs).toBeUndefined()
      // With every stamp rejected, there is no expiry data to summarise.
      expect(credits.expiry).toBeUndefined()
    })

    it('still reads a real leap day', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'leap', CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: '2028-02-29 10:00:00' },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      const end = credits.accounts[0]!.endTimeMs
      expect(end).toBeTypeOf('number')
      const parsed = new Date(end!)
      expect(parsed.getFullYear()).toBe(2028)
      expect(parsed.getMonth()).toBe(1)
      expect(parsed.getDate()).toBe(29)
    })

    it('buckets credit by horizon and only counts positive balances', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'soon', CycleCapacitySize: 100, CycleCapacityRemain: 10, CycleEndTime: at(2 * HOUR) },
        { PackageName: 'mid', CycleCapacitySize: 100, CycleCapacityRemain: 20, CycleEndTime: at(2 * DAY) },
        { PackageName: 'week', CycleCapacitySize: 100, CycleCapacityRemain: 30, CycleEndTime: at(5 * DAY) },
        { PackageName: 'later', CycleCapacitySize: 100, CycleCapacityRemain: 40, CycleEndTime: at(20 * DAY) },
        // Zero balance inside the window must not inflate the at-risk number.
        { PackageName: 'spent', CycleCapacitySize: 100, CycleCapacityRemain: 0, CycleEndTime: at(1 * HOUR) },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      const expiry = credits.expiry
      expect(expiry).toBeDefined()
      expect(expiry!.within24h).toMatchObject({ total: 10, packages: 1 })
      expect(expiry!.within3d).toMatchObject({ total: 30, packages: 2 })
      expect(expiry!.within7d).toMatchObject({ total: 60, packages: 3 })
      // The 20-day package is outside every window and must not be counted.
      expect(credits.total).toBe(100)
    })

    it('keeps a lapsed package out of every future horizon', async () => {
      // The personal billing query filters `Status: [0, 3]` from the current time
      // forward, so a lapsed package should not arrive here at all. This pins the
      // guard that keeps one from being read as "expiring within 24 hours" if it
      // ever did: `end - now` is negative, so a naive forward test would match
      // every horizon at once.
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'lapsed', CycleCapacitySize: 100, CycleCapacityRemain: 25, CycleEndTime: at(-1 * HOUR) },
        { PackageName: 'live', CycleCapacitySize: 100, CycleCapacityRemain: 5, CycleEndTime: at(30 * DAY) },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      expect(credits.expiry!.within24h).toMatchObject({ total: 0, packages: 0 })
      expect(credits.expiry!.within3d).toMatchObject({ total: 0, packages: 0 })
      expect(credits.expiry!.within7d).toMatchObject({ total: 0, packages: 0 })
      // Its balance is still part of the raw total: this PR does not change how
      // `total` is summed, only what the card chooses to warn about.
      expect(credits.total).toBe(30)
    })

    it('names the soonest expiry for each bucket', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
        { PackageName: 'b', CycleCapacitySize: 10, CycleCapacityRemain: 1, CycleEndTime: at(3 * DAY) },
        { PackageName: 'a', CycleCapacitySize: 10, CycleCapacityRemain: 1, CycleEndTime: at(4 * DAY) },
      ]))))

      const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      const earliest = credits.expiry!.within7d.earliestEndTimeMs
      expect(earliest).toBeTypeOf('number')
      // 'b' expires first and must be the one named.
      expect(Math.abs((earliest ?? 0) - (Date.now() + 3 * DAY))).toBeLessThan(2000)
    })
  })

  it('throws when the upstream business code is non-zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      JSON.stringify({ code: 1, msg: 'billing error' }),
    )))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/billing error/)
  })

  it('throws when the upstream returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('not json')))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/non-JSON/)
  })
})

/**
 * CN enterprise accounts are served by a different endpoint than personal
 * ones; asking the personal endpoint for an enterprise account answers with an
 * empty `Accounts` list, which renders as a confident "0 credit" (issue #31).
 *
 * The personal-path expectations above double as the zero-regression guard:
 * they run on `CREDENTIAL`, which carries no `enterpriseId`.
 */
describe('WorkBuddyUpstreamClient.fetchCredits (CN enterprise)', () => {
  const ENTERPRISE: WorkBuddyCredential = { ...CREDENTIAL, enterpriseId: 'ent-1' }

  /** The enterprise answer: a single cycle quota, not a package list. */
  function enterpriseEnvelope(fields: Record<string, unknown>): string {
    return JSON.stringify({ code: 0, msg: 'OK', data: fields })
  }

  it('requests the enterprise endpoint instead of the personal one', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 })))
    vi.stubGlobal('fetch', fetchMock)

    await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage')
    expect(url).not.toContain('get-user-resource')
  })

  it('sends the enterprise identity headers and an empty body', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 })))
    vi.stubGlobal('fetch', fetchMock)

    await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string>; body: string }
    expect(init.headers['X-Enterprise-Id']).toBe('ent-1')
    expect(init.headers['X-Tenant-Id']).toBe('ent-1')
    // Identity travels in the headers only; the body stays an empty object.
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('reads camelCase quota fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(380)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 380, size: 500 }])
    expect(credits.unlimited).toBeUndefined()
  })

  it('reads snake_case quota fields (the app has both spellings)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limit_num: 500, used_num: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(380)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 380, size: 500 }])
  })

  it('marks limitNum -1 as unlimited rather than a negative balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: -1, credit: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.unlimited).toBe(true)
    // Never a negative number, and never a zero that reads as "exhausted".
    expect(credits.total).toBe(0)
    expect(credits.accounts[0]!.remain).toBe(0)
  })

  it('clamps remaining quota to zero when usage exceeds limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 600 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 0, size: 500 }])
  })

  it('parses cycleResetTime when present in the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({
      limitNum: 500, credit: 120, cycleResetTime: '2026-10-01T00:00:00Z',
    }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.cycleResetTime).toBe('2026-10-01T00:00:00Z')
  })

  it('throws a diagnosable error when no quota field is recognised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ unexpected: 'shape' }))))

    // Must be a hard error: silently returning 0 is what hid issue #31.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised quota field/)
  })

  it('throws when a limit arrives without any recognised usage field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500 }))))

    // Defaulting the missing usage to 0 would render a confident "500 remaining"
    // from a half-read response: the same wrong-but-plausible number the
    // enterprise branch exists to prevent.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised usage field/)
  })

  it('throws when the usage field is present but not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: '120' }))))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised usage field/)
  })

  it('reports the received fields when the usage field is missing, without values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      enterpriseEnvelope({ limitNum: 500, secretUsed: 4242 }),
    )))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)
      .then(() => undefined, (reason: unknown) => reason as Error)

    expect(error?.message).toContain('secretUsed:number')
    expect(error?.message).not.toContain('4242')
  })

  it('still accepts an explicit zero usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 0 }))))

    // Zero used is a real reading and must not be mistaken for a missing field.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(500)
    expect(credits.unlimited).toBeUndefined()
  })

  it('does not require a usage field when the quota is uncapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: -1 }))))

    // An uncapped reading has no balance to subtract, so a missing used amount
    // is not a parse failure here.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.unlimited).toBe(true)
  })

  it('names the received fields in that error, without their values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      enterpriseEnvelope({ secretQuota: 998877, accountLabel: 'should-not-leak' }),
    )))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)
      .then(() => undefined, (reason: unknown) => reason as Error)

    // Field names and types are the diagnostic; values must not travel, since
    // this message reaches the browser and describes the account's usage.
    expect(error?.message).toContain('secretQuota:number')
    expect(error?.message).not.toContain('998877')
    expect(error?.message).not.toContain('should-not-leak')
  })

  it('keeps a personal credential on the personal endpoint', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    ])))
    vi.stubGlobal('fetch', fetchMock)

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('get-user-resource')
    expect(credits.total).toBe(40)
  })

  it('keeps an international credential on the personal endpoint even with an enterpriseId', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    ])))
    vi.stubGlobal('fetch', fetchMock)

    // The global enterprise endpoint is unverified, so the region gate must
    // hold: an international credential stays on the measured personal path.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits({
      ...CREDENTIAL,
      domain: 'www.workbuddy.ai',
      enterpriseId: 'ent-global',
    })

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('workbuddy.ai')
    expect(url).toContain('get-user-resource')
    expect(url).not.toContain('get-enterprise-user-usage')
    expect(credits.total).toBe(40)
  })
})

describe('normalizeCredits', () => {
  it('keeps a bare multiplier untouched', () => {
    expect(normalizeCredits('x0.79')).toBe('x0.79')
    expect(normalizeCredits('x0.00')).toBe('x0.00')
  })

  it('strips a trailing credits unit word', () => {
    expect(normalizeCredits('x0.79 credits')).toBe('x0.79')
    expect(normalizeCredits('x1.62 credits')).toBe('x1.62')
    expect(normalizeCredits('x0.79 CREDITS')).toBe('x0.79')
    expect(normalizeCredits('x0.79 credit')).toBe('x0.79')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCredits('  x0.79 credits  ')).toBe('x0.79')
  })

  it('returns undefined for absent or empty values', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('   ')).toBeUndefined()
    expect(normalizeCredits('credits')).toBeUndefined()
  })
})

describe('CN catalog: /v3/config roster, badge merge, and fallback consistency', () => {
  /**
   * The CN roster comes from the `/v3/config` product document — the same one
   * the desktop App's own selector reads — and the roster churns day to day,
   * so the static fallback in `catalog.ts` is only a boot-time placeholder.
   * This suite pins the mechanism (roster ∩ usable rows, badges merged from
   * the console document) and pins the fallback table itself to the same
   * parse, so the two cannot drift apart silently.
   */

  /** Raw `/v3/config` rows for the 2026-09-23 CN roster, verbatim from the live document. */
  const LIVE_ROWS: readonly Record<string, unknown>[] = [
    { id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['high'] }, credits: 'x0.29 credits' },
    { id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.00 credits' },
    { id: 'hy3-x', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.05 credits' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.03 credits' },
    { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 131_072, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.06 credits' },
    { id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
    { id: 'glm-5.1', name: 'GLM-5.1', maxInputTokens: 200_000, maxOutputTokens: 48_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.79 credits' },
    { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', maxInputTokens: 200_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.71 credits' },
    { id: 'minimax-m3', name: 'MiniMax-M3', maxInputTokens: 512_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.25 credits' },
    { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.19 credits' },
    { id: 'kimi-k3-1', name: 'Kimi-K3', maxInputTokens: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x1.62 credits' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] }, credits: 'x0.77 credits' },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', maxInputTokens: 256_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.57 credits' },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', maxInputTokens: 256_000, maxOutputTokens: 32_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'medium', summary: 'auto' }, credits: 'x0.52 credits' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: 'high', summary: 'auto' }, credits: 'x0.51 credits' },
  ]
  const LIVE_ROSTER = LIVE_ROWS.map(row => String(row['id']))
  /** Badge tags live only in the console document; verbatim from the same day. */
  const CONSOLE_BADGES = new Map<string, readonly string[]>([
    ['hy4-preview', ['badge:夜间免费:#FF0000']],
    ['hy3', ['badge:限时免费:#FF0000']],
    ['glm-5.2', ['badge:夜间折扣:#1E90FF']],
    ['deepseek-v4.1-flash', ['badge:独家优惠:#FF0000']],
  ])

  it('membership is the cli roster intersected with usable rows', () => {
    // A retired roster id with no row, a disabled row, and a zero-capped row
    // must all drop out; published-but-unservable ids never reach the picker.
    const document = {
      models: [
        ...LIVE_ROWS,
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5', maxInputTokens: 200_000, maxOutputTokens: 48_000, disabled: true, supportsReasoning: true, onlyReasoning: true },
        { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', maxInputTokens: 0, maxOutputTokens: 0 },
      ],
      agents: [{ name: 'cli', models: [...LIVE_ROSTER, 'kimi-k2.5'] }],
    }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models.map(model => model.id)).toEqual(LIVE_ROSTER)
  })

  it('merges the console document’s badge tags without trusting it for anything else', () => {
    const document = {
      models: LIVE_ROWS.filter(row => row['id'] === 'hy3'),
      agents: [{ name: 'cli', models: ['hy3'] }],
    }
    const models = parseModelCatalog(document, false, CONSOLE_BADGES)
    expect(models[0]?.billing).toEqual({ credits: 'x0.00 credits', badges: ['限时免费'], free: true })
  })

  it('the static fallback equals the live parse of the day it was captured', () => {
    // THE CONSISTENCY PIN: the fallback table must equal what the parser
    // produces from the raw document the table was transcribed from, on every
    // stable field — membership, order, metadata, credits, free flag.
    // Promotional badges are the deliberate exception: they are dynamic
    // console-side promotions, so they ride the live merge only and are
    // stripped here before the comparison. (The other deviation is
    // display-only: the fallback renames `hy3-x`, which the document names
    // "Hy3", and the parse cannot know to do that.)
    const document = { models: LIVE_ROWS, agents: [{ name: 'cli', models: LIVE_ROSTER }] }
    const parsed = parseModelCatalog(document, false, CONSOLE_BADGES)
    const stable = parsed.map(model => {
      const { badges: _badges, ...billing } = model.billing ?? {}
      return { ...model, billing }
    })
    const fallback = FALLBACK_WORKBUDDY_MODELS.map(model => model.id === 'hy3-x' ? { ...model, name: 'Hy3' } : model)
    expect(stable).toEqual(fallback)
    // The badges themselves stay live-only, never baked into the fallback.
    expect(FALLBACK_WORKBUDDY_MODELS.every(model => model.billing?.badges === undefined)).toBe(true)
    expect(parsed.filter(model => model.billing?.badges !== undefined).map(model => model.id).sort())
      .toEqual(['deepseek-v4.1-flash', 'glm-5.2', 'hy3', 'hy4-preview'])
  })
})

describe('WorkBuddyUpstreamClient.fetchModels badge merge', () => {
  it('reads the console document once for badges and ships without them when it fails', async () => {
    const calls: string[] = []
    const configEnvelope = JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        models: [{ id: 'm-1', name: 'Model One', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsReasoning: true, onlyReasoning: true, credits: 'x0.00 credits' }],
        agents: [{ name: 'cli', models: ['m-1'] }],
      },
    })
    const consoleEnvelope = JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm-1', tags: ['badge:限时免费:#FF0000', 'not-a-badge'] }] },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url instanceof Request ? url.url : url))
      return fakeResponse(calls.length === 1 ? configEnvelope : consoleEnvelope)
    }))
    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    // Second request is the console badge read, against the same CN base.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('/console/enterprises/personal/models')
    expect(calls[0]).toContain('/v3/config')
    expect(models[0]?.billing).toEqual({ credits: 'x0.00 credits', badges: ['限时免费'], free: true })

    // A console failure costs the badge, never the catalog.
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url instanceof Request ? url.url : url))
      if (calls.length === 1) return fakeResponse(configEnvelope)
      throw new Error('console endpoint offline')
    }))
    const withoutBadges = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(calls).toHaveLength(2)
    expect(withoutBadges.map(model => model.id)).toEqual(['m-1'])
    expect(withoutBadges[0]?.billing).toEqual({ credits: 'x0.00 credits', free: true })
  })
})

describe('chatStream wire effort by region (issue #49)', () => {
  /**
   * THE REGION-SPLIT ACCEPTANCE: judged on the request that actually leaves
   * `chatStream`, not on any intermediate helper. Both regions drop the
   * adapter's own `off` spelling and nothing else — the CN half used to be
   * exempt by an explicit scope decision, which #87 invalidated.
   */
  const AI_CREDENTIAL: WorkBuddyCredential = { ...CREDENTIAL, domain: 'www.workbuddy.ai' }

  /** Capture the body chatStream sends for one credential + effort value. */
  async function wireEffort(credential: WorkBuddyCredential, effort: string | undefined): Promise<unknown> {
    const calls: { body?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return fakeResponse('')
    }))
    const body: Record<string, unknown> = {
      model: 'probe-model',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
    }
    if (effort !== undefined) body['reasoning_effort'] = effort
    const result = await new WorkBuddyUpstreamClient().chatStream(credential, JSON.stringify(body))
    expect(result.ok).toBe(true)
    return calls[0]?.body === undefined ? undefined : (calls[0].body as Record<string, unknown>)['reasoning_effort']
  }

  it('drops the `off` spelling in both regions (issue #49 for global, #87 for CN)', async () => {
    // CN used to pass `off` through by an explicit scope decision. #87 measured
    // that endpoint rejecting it on `deepseek-v4.1-flash` (400 / 11150), which
    // invalidated the premise, so the strip is no longer region-scoped.
    expect(await wireEffort(CREDENTIAL, 'off')).toBeUndefined()
    expect(await wireEffort(AI_CREDENTIAL, 'off')).toBeUndefined()
  })

  it('omits the field entirely for `off` rather than substituting another spelling', async () => {
    // `none` is the tempting substitute and is *not* safe: accepted by the
    // GPT-5.6 family and GLM, rejected by `gpt-6-astra` (#49).
    const captured: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return fakeResponse('')
    }))
    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, JSON.stringify({
      model: 'probe-model',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    expect(result.ok).toBe(true)
    expect('reasoning_effort' in (captured[0] ?? {})).toBe(false)
    expect(captured[0]?.['model']).toBe('probe-model')
  })

  it('declared spellings and `none` are untouched in both regions', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      expect(await wireEffort(CREDENTIAL, effort)).toBe(effort)
      expect(await wireEffort(AI_CREDENTIAL, effort)).toBe(effort)
    }
  })
})

describe('extractDisplayErrorMessage (PR #58)', () => {
  it('extracts zh displayMsg from structured JSON', () => {
    const raw = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      displayMsg: {
        zh: '内容未通过安全审核，请调整后重试。',
        en: 'The content did not pass the safety review. Please adjust and retry.',
      },
    })
    expect(extractDisplayErrorMessage(raw)).toBe('内容未通过安全审核，请调整后重试。')
  })

  it('falls back to en displayMsg when zh is missing', () => {
    const raw = JSON.stringify({
      code: 11140,
      msg: 'request illegal',
      displayMsg: { en: 'The content did not pass the safety review. Please adjust and retry.' },
    })
    expect(extractDisplayErrorMessage(raw)).toBe('The content did not pass the safety review. Please adjust and retry.')
  })

  it('falls back to msg when displayMsg is absent', () => {
    const raw = JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' })
    expect(extractDisplayErrorMessage(raw)).toBe('Illegal API invocation from an unapproved channel')
  })

  it('returns undefined for non-JSON or malformed bodies', () => {
    expect(extractDisplayErrorMessage('502 Bad Gateway')).toBeUndefined()
    expect(extractDisplayErrorMessage('')).toBeUndefined()
    expect(extractDisplayErrorMessage('{ invalid json')).toBeUndefined()
  })
})

describe('auth-failure classification beside the status-note policy (PR #58 review)', () => {
  it('classifies every 401 as session_dead even without a body marker', () => {
    // The status-note policy hides `401`/`403` from business errors; a bare
    // 401 must therefore never fall through to `client`, or its error text
    // would lose the AUTH signal the host keys on.
    expect(classifyUpstreamError(401, 'whatever the body says')).toBe('session_dead')
    expect(classifyUpstreamError(401, '')).toBe('session_dead')
  })

  it('still classifies a markerless 403 as a business error', () => {
    expect(classifyUpstreamError(403, JSON.stringify({ code: 11140, msg: 'request illegal' }))).toBe('client')
  })

  it('still recognises dead sessions carried by markers on other statuses', () => {
    expect(classifyUpstreamError(403, 'Offline user session not found')).toBe('session_dead')
    expect(classifyUpstreamError(200, JSON.stringify({ code: 12153 }))).toBe('session_dead')
  })
})

/**
 * Regression coverage for the three defects fixed in `src/upstream.ts`.
 *
 * 1. A rate limiter whose body carries a credit word must not be read as
 *    exhausted credit — that reported a permanent failure (and told the user to
 *    top up) for a transient condition.
 * 2. No request may follow a redirect: the refresh request carries the refresh
 *    token in a custom header undici would forward to whatever host a 302
 *    names.
 * 3. No response body may be read without a cap, since `.text()` buffers the
 *    whole thing before any slice can trim it.
 */

/** A response double carrying a real (chunked) body stream, so caps are observable. */
function streamingResponse(
  chunks: readonly string[],
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): { response: Response; cancelled: () => boolean; pulled: () => number; producedBytes: () => number } {
  const encoded = chunks.map(chunk => new TextEncoder().encode(chunk))
  let index = 0
  let cancelled = false
  let produced = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= encoded.length) {
        controller.close()
        return
      }
      const chunk = encoded[index] as Uint8Array
      controller.enqueue(chunk)
      index += 1
      produced += chunk.byteLength
    },
    cancel() {
      cancelled = true
    },
  })
  const response = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    body: stream,
    text: () => Promise.reject(new Error('the capped reader must not call .text() on a streaming body')),
  } as unknown as Response
  return { response, cancelled: () => cancelled, pulled: () => index, producedBytes: () => produced }
}

/** `n` bytes of JSON-safe filler, so one chunk can stand for a huge body. */
function filler(n: number): string {
  return 'x'.repeat(n)
}

describe('classifyUpstreamError ordering (rate limiting is not credit exhaustion)', () => {
  it('keeps a 429 soft_rate even when its body screams hard credit', async () => {
    const { classifyUpstreamError } = await import('../src/upstream.ts')
    // 'quota exceeded' is ordinary rate-limit phrasing, and it is also a hard
    // credit marker. The status must win: reading this as hard_credit made the
    // host stop retrying permanently and tell the user to top up credits they
    // already had.
    expect(classifyUpstreamError(429, 'quota exceeded')).toBe('soft_rate')
    expect(classifyUpstreamError(429, JSON.stringify({ code: 429, msg: 'insufficient credit' }))).toBe('soft_rate')
    expect(classifyUpstreamError(429, '积分不足')).toBe('soft_rate')
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
  })

  it('keeps a 402 hard_credit whatever its body says', async () => {
    const { classifyUpstreamError } = await import('../src/upstream.ts')
    expect(classifyUpstreamError(402, 'slow down')).toBe('hard_credit')
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('keeps body markers authoritative where the status states nothing', async () => {
    const { classifyUpstreamError } = await import('../src/upstream.ts')
    // A 403 carrying a session-dead marker is a dead session, not a client error.
    expect(classifyUpstreamError(403, 'Offline user session not found')).toBe('session_dead')
    expect(classifyUpstreamError(403, JSON.stringify({ code: 12153 }))).toBe('session_dead')
    // Credit markers still classify an otherwise-uninformative status.
    expect(classifyUpstreamError(400, 'insufficient credit')).toBe('hard_credit')
    expect(classifyUpstreamError(200, JSON.stringify({ code: 1, msg: 'quota exceeded' }))).toBe('hard_credit')
  })

  it('never lets a body marker turn a 429 into a permanent failure', async () => {
    // The end-to-end shape of the bug: a real chat answer of 429 whose body
    // names credits. chatStream must hand the host soft_rate.
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('{"code":429,"msg":"insufficient credit"}', false, 429)))
    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, JSON.stringify({ model: 'm', messages: [] }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('soft_rate')
    expect(result.status).toBe(429)
  })
})

describe('redirects are never followed', () => {
  /** A 302 whose Location points at a host the plugin never talks to. */
  const REDIRECT = 'https://attacker.example/collect'

  it('asks every request not to follow redirects', async () => {
    const inits: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init ?? {})
      return fakeResponse(JSON.stringify({ code: 0, msg: 'ok', data: { limitNum: 5, credit: 1 } }))
    }))
    const client = new WorkBuddyUpstreamClient()

    await client.chatStream(CREDENTIAL, JSON.stringify({ model: 'm', messages: [] }))
    await client.refreshToken(CREDENTIAL).catch(() => undefined)
    await client.fetchModels(CREDENTIAL).catch(() => undefined)
    await client.fetchCredits({ ...CREDENTIAL, enterpriseId: 'ent-1' }).catch(() => undefined)

    expect(inits.length).toBeGreaterThanOrEqual(4)
    for (const init of inits) expect(init.redirect).toBe('manual')
  })

  it('refuses a refresh redirect instead of forwarding the refresh token', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url))
      expect(init?.redirect).toBe('manual')
      // The token-bearing request is the only one made: nothing is sent to the
      // host the redirect names.
      expect((init?.headers as Record<string, string>)['X-Refresh-Token']).toBe('rt')
      return { ok: false, status: 302, headers: new Headers({ Location: REDIRECT }) } as unknown as Response
    }))

    const error = await new WorkBuddyUpstreamClient().refreshToken(CREDENTIAL)
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error).toBeDefined()
    expect(error?.message).toContain('302')
    expect(error?.message).toContain('redirect')
    // Exactly one request, to the refresh endpoint; the redirect target is
    // never contacted.
    expect(urls).toEqual(['https://copilot.tencent.com/v2/plugin/auth/token/refresh'])
  })

  it('reports a chat redirect as a failure rather than a stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 302, headers: new Headers({ Location: REDIRECT }),
    } as unknown as Response)))

    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, JSON.stringify({ model: 'm', messages: [] }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(302)
    expect(result.message).toContain('302')
    expect(result.message).toContain('redirect')
  })

  it('fails the catalog on a redirect instead of parsing the redirect body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: () => Promise.resolve('{"models":[],"agents":[]}'),
    } as unknown as Response)))

    // Sanity: the catalog path works when nothing redirects.
    await expect(new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)).rejects.toThrow(/cli agent/)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 301, text: () => Promise.resolve('{"code":0,"msg":"ok","data":{}}'),
    } as unknown as Response)))
    await expect(new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)).rejects.toThrow(/301 redirect/)
  })
})

describe('response bodies are read with a cap', () => {
  it('stops pulling a chat error body at the excerpt cap and cancels the rest', async () => {
    // 100 chunks of 4 KiB (400 KiB total) against the 4096-byte excerpt cap.
    const total = 100
    const chunkSize = 4096
    const { response, cancelled, pulled, producedBytes } = streamingResponse(
      Array.from({ length: total }, () => filler(chunkSize)),
      { ok: false, status: 500 },
    )
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, JSON.stringify({ model: 'm', messages: [] }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(500)
    // 4096 is ERROR_BODY_LIMIT: the message is bounded by it.
    expect(result.message).toHaveLength(4096)
    // The read stopped at the cap — at most one further chunk may already have
    // been queued by the stream itself — instead of buffering all 400 KiB.
    expect(producedBytes()).toBeLessThanOrEqual(chunkSize * 2)
    expect(pulled()).toBeLessThan(total)
    expect(cancelled()).toBe(true)
  })

  it('caps the probe error body the same way', async () => {
    const total = 100
    const chunkSize = 4096
    const { response, cancelled, producedBytes } = streamingResponse(
      Array.from({ length: total }, () => filler(chunkSize)),
      { ok: false, status: 500 },
    )
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const attempt = await new WorkBuddyUpstreamClient()
      .probeEffort(CREDENTIAL, 'model-x', undefined, new AbortController().signal)
    expect(attempt.status).toBe(500)
    expect((attempt.detail ?? '').length).toBeLessThanOrEqual(200)
    expect(producedBytes()).toBeLessThan(total * chunkSize)
    expect(cancelled()).toBe(true)
  })

  it('stops pulling a JSON envelope at its own, larger cap', async () => {
    // A document many times the cap: the read must end at the cap instead of
    // buffering everything that follows.
    const total = 16
    const chunkSize = 1024 * 1024
    const { response, cancelled, pulled, producedBytes } = streamingResponse(
      Array.from({ length: total }, () => filler(chunkSize)),
    )
    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/non-JSON/)
    // The 8 MiB cap, plus at most the one chunk the stream had already queued.
    expect(producedBytes()).toBeLessThanOrEqual(9 * chunkSize)
    expect(pulled()).toBeLessThan(total)
    expect(cancelled()).toBe(true)
  })

  it('still parses a normal catalog body through the capped reader', async () => {
    const body = JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models: [{ id: 'm-1', name: 'Model One', maxInputTokens: 100_000, maxOutputTokens: 32_000 }],
        agents: [{ name: 'cli', models: ['m-1'] }],
      },
    })
    const { response } = streamingResponse([body])
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models.map(model => model.id)).toEqual(['m-1'])
  })

  it('reassembles a body split mid-character across chunks', async () => {
    // '积分不足' split inside a multi-byte character: the decode must not mangle
    // it, since the result reaches the user as the error text.
    const bytes = new TextEncoder().encode('{"code":1,"msg":"积分不足"}')
    const cut = 17
    const parts = [bytes.slice(0, cut), bytes.slice(cut)]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: stream } as unknown as Response)))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('积分不足')
  })
})

