import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `processStartTimeMs` imports `execFileSync` from `node:child_process`, whose
 * ESM namespace cannot be spied on. Hoisted module mock: the real module is
 * used everywhere except where a test scripts the child's answer here.
 *
 * The win32 branch now runs a PowerShell **primary** and a `wmic.exe`
 * **fallback**, so "one canned string for every call" is no longer enough to
 * pin the behaviour: the stage that answered, and the absolute binary each
 * stage asked for, are both part of the contract. Hence three seams —
 * {@link processQuery.output} (any call), {@link processQuery.handler} (answer
 * by binary, when the two stages must disagree) and {@link processQuery.calls}
 * (what was actually spawned). Nothing here stubs `process.platform`, so every
 * case that exercises win32 sets it itself.
 */
const processQuery = vi.hoisted(() => ({
  output: undefined as string | undefined,
  handler: undefined as ((binary: string) => string) | undefined,
  calls: [] as { binary: string, args: string[], options: Record<string, unknown> }[],
  reset(): void {
    processQuery.output = undefined
    processQuery.handler = undefined
    processQuery.calls = []
  },
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (binary: unknown, args: unknown, options: unknown) => {
      const binaryPath = String(binary)
      const argv = (args ?? []) as string[]
      processQuery.calls.push({
        binary: binaryPath,
        args: argv,
        options: (options ?? {}) as Record<string, unknown>,
      })
      if (processQuery.handler !== undefined) return processQuery.handler(binaryPath)
      if (processQuery.output !== undefined) return processQuery.output
      return (actual.execFileSync as (...a: unknown[]) => unknown)(binary, args, options)
    },
  }
})

import {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  parseWmiCreationDate,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  writeHostHeartbeat,
  WINDOWS_PROCESS_START_TIME_SCRIPT,
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  WORKBUDDY_PROCESS_QUERY_STEP_TIMEOUT_MS,
} from '../src/host-heartbeat.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

let root: string | undefined

/**
 * Real `wmic` output: a `CreationDate` header, the value, then a blank line.
 * Shared by the win32 cases below, including the `wmic.exe` fallback stage.
 */
const wmicOutput = (value: string): string => `CreationDate\n${value}\n\n`

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  processQuery.reset()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('host heartbeat', () => {
  it('writes, reads, and clears a heartbeat under $DSH_HOME', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-'))
    vi.stubEnv('DSH_HOME', root)

    // Before write: absent.
    expect(await readHostHeartbeat()).toBeUndefined()

    await writeHostHeartbeat()

    // After write: present and well-formed.
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat!.package).toBe('dsh-workbuddy-connect')
    expect(heartbeat!.pid).toBe(process.pid)
    expect(typeof heartbeat!.registeredAt).toBe('number')
    expect(heartbeat!.pluginVersion).toBe(WORKBUDDY_CONNECT_VERSION)

    // The file lives at the expected path.
    expect(workbuddyHostHeartbeatPath()).toBe(join(root, WORKBUDDY_HOST_HEARTBEAT_FILENAME))

    // Live PID is detectable.
    expect(isHeartbeatProcessAlive(heartbeat!)).toBe(true)

    // A fake PID that cannot exist is detected as dead.
    const fakeHeartbeat = { ...heartbeat!, pid: 999_999 }
    expect(isHeartbeatProcessAlive(fakeHeartbeat)).toBe(false)

    // Clear removes the file.
    await clearHostHeartbeat()
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('detects a recycled PID as dead (registeredAt after this process started)', async () => {
    // The process holding the recorded PID started at some fixed point. If a
    // stale heartbeat claims a `registeredAt` that is *older* than that, the
    // PID cannot be the original host — it has been recycled by an unrelated
    // process. Even though `kill(pid, 0)` says the PID is alive, the age check
    // must report dead.
    //
    // The start time is injected rather than measured: the rule under test is
    // pure comparison over `startAtMs` and `registeredAt`. Calling the real
    // `wmic` here made this case's duration the host's subprocess latency
    // (measured 0.9-6.9s across runs, against a 5s timeout), so it failed
    // whenever wmic happened to be slow — an environmental dependency, not a
    // defect in the logic under test. The wmic output -> epoch parsing it used
    // to lean on is covered by the `processStartTimeMs` cases below, which
    // drive the same win32 branch with the same hoisted mock.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    processQuery.output = `CreationDate\n20260923104314.239907+480\n\n`
    const startAtMs = processStartTimeMs(process.pid)
    expect(startAtMs).toBeDefined()

    // A heartbeat registered *before* this process began (the recycled-PID case).
    const recycled = {
      version: 1 as const,
      package: 'dsh-workbuddy-connect' as const,
      pluginVersion: '0.0.0-test',
      registeredAt: (startAtMs as number) - 60_000, // 1 min before this process started
      pid: process.pid,
    }
    expect(isHeartbeatProcessAlive(recycled)).toBe(false)

    // A heartbeat registered *after* this process started (a genuine host on
    // this very PID) is alive.
    const genuine = { ...recycled, registeredAt: Date.now() }
    expect(isHeartbeatProcessAlive(genuine)).toBe(true)
  })

  it('treats a malformed heartbeat file as absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-malformed-'))
    vi.stubEnv('DSH_HOME', root)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(workbuddyHostHeartbeatPath(), '{ not json', 'utf8')
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a heartbeat with the wrong format version', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-heartbeat-wrongver-'))
    vi.stubEnv('DSH_HOME', root)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      workbuddyHostHeartbeatPath(),
      JSON.stringify({ version: 99, package: 'dsh-workbuddy-connect', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })
})

describe('parseWmiCreationDate (CIM_DATETIME)', () => {
  /**
   * Windows `wmic` prints `CreationDate` as CIM_DATETIME
   * `yyyymmddHHMMSS.mmmmmmsUUU`: local wall-clock fields plus a 3-digit
   * signed UTC offset **in minutes**. The epoch is the UTC-shifted fields —
   * `+480` (UTC+8) must subtract 480 minutes, which is what the old
   * 4-digit-offset regex never matched and never applied (issue #47).
   */

  it('parses the listed offsets into the correct epoch', () => {
    // Zero offset: fields are already UTC.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+000')!).toISOString())
      .toBe('2026-09-23T10:43:14.000Z')
    // UTC+8: local 10:43:14 is 02:43:14Z.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+480')!).toISOString())
      .toBe('2026-09-23T02:43:14.000Z')
    // UTC+5:30 (India): 10:43:14 − 5h30m.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+330')!).toISOString())
      .toBe('2026-09-23T05:13:14.000Z')
    // UTC−5: 10:43:14 + 5h.
    expect(new Date(parseWmiCreationDate('20260923104314.239907-300')!).toISOString())
      .toBe('2026-09-23T15:43:14.000Z')
    // Extreme offsets cross the day boundary and stay finite.
    expect(new Date(parseWmiCreationDate('20260923104314.239907+840')!).toISOString())
      .toBe('2026-09-22T20:43:14.000Z')
    expect(new Date(parseWmiCreationDate('20260923104314.239907-720')!).toISOString())
      .toBe('2026-09-23T22:43:14.000Z')
  })

  it('rejects malformed input and 4-digit offsets instead of partially matching', () => {
    expect(parseWmiCreationDate('')).toBeUndefined()
    expect(parseWmiCreationDate('garbage')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907+48')).toBeUndefined()
    // A 4-digit offset is not the CIM format; matching its first three digits
    // would silently compute a wrong epoch.
    expect(parseWmiCreationDate('20260923104314.239907+4800')).toBeUndefined()
    expect(parseWmiCreationDate('20260923104314.239907-3000')).toBeUndefined()
    // Date parts that Date.UTC would silently roll over are malformed too.
    expect(parseWmiCreationDate('20261323104314.239907+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260932104314.239907+000')).toBeUndefined()
    expect(parseWmiCreationDate('20260923254314.239907+000')).toBeUndefined()
  })
})

describe('processStartTimeMs wmic token extraction (production path)', () => {
  /**
   * The production branch looks up its own datetime token in `wmic` output
   * before handing it to {@link parseWmiCreationDate}. That extraction step is
   * a second, independent chance to partially match: a bare
   * `(\d{14})\.(\d+)([+-]\d{3})` would cut `...+4800` down to `...+480`, which
   * then sails through the strict parser as a *valid* token and produces a
   * wrong epoch. The parser-level tests above cannot catch that, because they
   * never see the truncated string. These tests drive the real win32 branch
   * with stubbed `wmic` output.
   */


  /**
   * Drive the real win32 branch: fake the platform, and let the hoisted
   * `node:child_process` mock hand `processStartTimeMs` this output.
   *
   * The same canned answer is returned for *every* child, so the PowerShell
   * primary consumes it and the `wmic.exe` fallback is never reached; the
   * fallback has its own cases further down.
   */
  function withWindowsWmic(output: string, run: () => void): void {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    processQuery.output = output
    run()
  }

  it('parses the real UTC+8 wmic value into the correct epoch', () => {
    withWindowsWmic(wmicOutput('20260923104314.239907+480'), () => {
      // 10:43:14 local at UTC+8 is 02:43:14Z; the offset must be subtracted.
      expect(new Date(processStartTimeMs(1234)!).toISOString()).toBe('2026-09-23T02:43:14.000Z')
    })
  })

  it('returns undefined for a 4-digit offset instead of matching its first 3 digits', () => {
    withWindowsWmic(wmicOutput('20260923104314.239907+4800'), () => {
      // Must degrade to the PID-only fallback, not report a truncated `+480`
      // epoch that would look trustworthy to the recycled-PID guard.
      expect(processStartTimeMs(1234)).toBeUndefined()
    })
  })

  it('returns undefined when wmic prints no datetime token at all', () => {
    withWindowsWmic('CreationDate\n\n\n', () => {
      expect(processStartTimeMs(1234)).toBeUndefined()
    })
  })
})

describe('processStartTimeMs Windows branch: absolute paths and bounded subprocesses', () => {
  /**
   * The reviewed defect: the win32 branch spawned a bare `wmic`, which the OS
   * resolves through PATH — user-writable, so a planted `wmic.exe` would be
   * executed by the *host process* — and it passed no timeout, so a wedged WMI
   * provider could hang the status CLI indefinitely. Both are pinned here.
   *
   * The discovery modules in this repo (`desktop-credential-protection.ts`,
   * `file-permissions.ts`) already resolve their Windows tools absolutely from
   * %SystemRoot%; these cases hold this module to the same rule.
   */

  it('resolves both stages from %SystemRoot% and never through PATH', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    // Empty answers drive the primary into the fallback, so both paths spawn.
    processQuery.handler = () => ''

    expect(processStartTimeMs(4321)).toBeUndefined()

    const spawned = processQuery.calls.map(call => call.binary)
    expect(spawned).toEqual([
      join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      join('C:\\Windows', 'System32', 'wbem', 'wmic.exe'),
    ])
    // The literal regression: nothing is spawned by bare name.
    for (const binary of spawned) {
      expect(binary).not.toBe('wmic')
      expect(binary).not.toBe('powershell')
      expect(binary.includes('\\')).toBe(true)
    }
  })

  it('bounds every stage with an explicit timeout and a maxBuffer', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    processQuery.handler = () => ''

    processStartTimeMs(4321)

    expect(processQuery.calls).toHaveLength(2)
    for (const call of processQuery.calls) {
      expect(typeof call.options.timeout).toBe('number')
      expect(call.options.timeout).toBe(WORKBUDDY_PROCESS_QUERY_STEP_TIMEOUT_MS)
      expect(call.options.timeout as number).toBeGreaterThan(0)
      expect(typeof call.options.maxBuffer).toBe('number')
      expect(call.options.windowsHide).toBe(true)
      // stderr is drained, not piped into the host's own stderr.
      expect(call.options.stdio).toEqual(['ignore', 'pipe', 'ignore'])
    }
  })

  it('asks powershell.exe for the raw CIM_DATETIME, not a culture-formatted date', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    processQuery.handler = () => ''

    processStartTimeMs(4321)

    const [powershellCall] = processQuery.calls
    expect(powershellCall).toBeDefined()
    expect(powershellCall!.args).toContain('-NoProfile')
    expect(powershellCall!.args).toContain('-NonInteractive')
    // The production script verbatim, wrapped so the trailing argv binds to
    // its param block (see WINDOWS_PROCESS_START_TIME_SCRIPT).
    expect(powershellCall!.args).toContain(`& { ${WINDOWS_PROCESS_START_TIME_SCRIPT} }`)
    // Get-WmiObject returns CreationDate as the DMTF string this parser is
    // written for; Get-CimInstance would materialize a culture-rendered
    // System.DateTime instead (measured 10/11/2026 17:10:05 under de-DE).
    expect(WINDOWS_PROCESS_START_TIME_SCRIPT).toContain('Get-WmiObject')
    expect(WINDOWS_PROCESS_START_TIME_SCRIPT).not.toContain('Get-CimInstance')
    // A param block must lead the script block, and the PID is typed, so the
    // value interpolated into the WQL filter can only be a number.
    expect(WINDOWS_PROCESS_START_TIME_SCRIPT.startsWith('param([int]$TargetProcessId)')).toBe(true)
    // The PID travels as its own argv element, never interpolated into the
    // command text.
    expect(powershellCall!.args).toContain('-TargetProcessId')
    expect(powershellCall!.args).toContain('4321')
    expect(powershellCall!.args[powershellCall!.args.length - 1]).toBe('4321')
  })

  it('falls back to the absolute wmic.exe when powershell.exe cannot answer', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    processQuery.handler = binary =>
      /powershell/iu.test(binary) ? '' : wmicOutput('20260923104314.239907+480')

    // The fallback answer is the real UTC+8 value: 10:43:14 local is 02:43:14Z.
    expect(new Date(processStartTimeMs(4321)!).toISOString()).toBe('2026-09-23T02:43:14.000Z')
    expect(processQuery.calls.map(call => call.binary)).toHaveLength(2)
  })

  it('prefers the primary and never spawns the fallback when it answers', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    processQuery.handler = binary =>
      /powershell/iu.test(binary) ? '20260923104314.239907+330' : wmicOutput('20200101000000.000000+000')

    // UTC+5:30 — proves the primary's own value was the one parsed.
    expect(new Date(processStartTimeMs(4321)!).toISOString()).toBe('2026-09-23T05:13:14.000Z')
    expect(processQuery.calls).toHaveLength(1)
  })

  it('returns undefined instead of resolving a tool when SystemRoot is unset', () => {
    // No SystemRoot means no absolute path to either tool. The rule is that a
    // tool is never reached through PATH, so the answer is "we could not tell"
    // (plain PID liveness), never a PATH-resolved spawn.
    vi.stubEnv('SystemRoot', '')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    expect(processStartTimeMs(4321)).toBeUndefined()
    expect(processQuery.calls).toHaveLength(0)
  })

  it('degrades to undefined when the child fails or produces no datetime', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    // Both stages fail (spawn error / non-zero exit / timeout kill).
    processQuery.handler = () => {
      throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    }
    expect(processStartTimeMs(4321)).toBeUndefined()
    expect(processQuery.calls).toHaveLength(2)

    processQuery.reset()
    // Both stages answer, but neither carries a usable token.
    processQuery.output = 'garbage'
    expect(processStartTimeMs(4321)).toBeUndefined()
  })
})

