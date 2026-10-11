/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddy` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * The browser (client) bundle cannot write files; its health is reported
 * only through `console.error` on failure (see `src/client/index.tsx`).
 * This asymmetry is intentional: the host is the load-bearing half, and
 * a missing heartbeat unambiguously means the host never started.
 *
 * @module dsh-workbuddy-connect/host-heartbeat
 */

import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WORKBUDDY_CONNECT_VERSION } from './version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const WORKBUDDY_HOST_HEARTBEAT_FILENAME = '.workbuddy-host-heartbeat.json'

/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1

/** On-disk shape of the heartbeat. */
export interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  package: 'dsh-workbuddy-connect'
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
}

/** Absolute path of the host heartbeat file. */
export function workbuddyHostHeartbeatPath(): string {
  return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME)
}

/**
 * Write (or overwrite) the heartbeat after the host bundle registered the
 * provider. A failed write is non-fatal: the host is already running, and
 * the status CLI will simply report "heartbeat missing" rather than failing.
 */
export async function writeHostHeartbeat(): Promise<void> {
  const document: WorkBuddyHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: 'dsh-workbuddy-connect',
    pluginVersion: WORKBUDDY_CONNECT_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  try {
    await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(document), 'utf8')
  } catch {
    // Non-fatal: the CLI status will show "heartbeat missing".
  }
}

/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
export async function clearHostHeartbeat(): Promise<void> {
  try {
    await rm(workbuddyHostHeartbeatPath(), { force: true })
  } catch {
    // Best-effort cleanup; a stale heartbeat is harmless (PID mismatch is detected by the reader).
  }
}

/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
export async function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined> {
  let raw: string
  try {
    raw = await readFile(workbuddyHostHeartbeatPath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkBuddyHostHeartbeat>
    if (
      parsed.version === HEARTBEAT_FORMAT_VERSION
      && parsed.package === 'dsh-workbuddy-connect'
      && typeof parsed.registeredAt === 'number'
      && typeof parsed.pid === 'number'
    ) {
      return {
        version: HEARTBEAT_FORMAT_VERSION,
        package: 'dsh-workbuddy-connect',
        pluginVersion: typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : 'unknown',
        registeredAt: parsed.registeredAt,
        pid: parsed.pid,
      }
    }
  } catch {
    // Malformed JSON; treat as absent.
  }
  return undefined
}

/**
 * Parse a WMI `CreationDate` (CIM_DATETIME) into epoch milliseconds; returns
 * `undefined` for anything that does not match the format, never throws.
 *
 * The CIM_DATETIME layout is `yyyymmddHHMMSS.mmmmmmsUUU`: local wall-clock
 * fields, a 6-digit microsecond fraction, and a **3-digit signed UTC offset
 * in minutes** (`+000`, `+480` for UTC+8, `-300` for UTC−5). The fields are
 * therefore *not* UTC — the offset must be subtracted to obtain the epoch:
 * `+480` means local time runs 480 minutes ahead of UTC, so
 * `20260923104314.239907+480` is `2026-09-23T02:43:14.000Z`. A 4-digit offset
 * is not part of the format and is rejected rather than partially matched.
 */
export function parseWmiCreationDate(value: string): number | undefined {
  const m = value
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d{3})$/)
  if (m === null) return undefined
  const [, y, mo, d, h, mi, s, , offset] = m
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number]
  // Structural sanity beyond the digit shape: reject values Date.UTC would
  // silently roll over (month 13, day 32, hour 99, …).
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second)
    - Number(offset) * 60_000
  return Number.isFinite(epoch) ? epoch : undefined
}

/**
 * Absolute tool paths: never resolved through PATH, which a user can change.
 * The same rule `desktop-credential-protection.ts` and `file-permissions.ts` follow for
 * their Windows subprocesses.
 */
const WINDOWS_POWERSHELL_RELATIVE = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const WINDOWS_WMIC_RELATIVE = 'System32\\wbem\\wmic.exe'

/**
 * One start-time lookup reads a single local WMI row, so it gets a tighter
 * bound than the 3s-per-step registry discovery in
 * `desktop-credential-protection.ts` (that one walks whole registry subtrees).
 * Measured on Windows 11 26100 (zh-CN): the PowerShell primary answers in
 * 0.66-0.78s, the `wmic.exe` fallback in 0.21s. A call is at worst two bounded
 * stages, so a wedged WMI provider cannot hang the status CLI.
 */
export const WORKBUDDY_PROCESS_QUERY_STEP_TIMEOUT_MS = 2_000

/** A `CreationDate` is a few hundred bytes; cap the pipe against a wedged child. */
const WINDOWS_PROCESS_QUERY_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * The start-time query, run by Windows PowerShell 5.1 (`powershell.exe`, which
 * ships with Windows and is therefore reliable in a way `pwsh` is not).
 *
 * Why PowerShell is the primary and `wmic.exe` only the fallback: WMIC is
 * removed from Windows 11 24H2 onward, so on a current machine the old bare
 * `wmic` lookup simply failed and the caller silently degraded to PID-only
 * liveness, where a recycled PID reads as the same live host — the exact
 * confusion this function exists to prevent.
 *
 * Why `Get-WmiObject` rather than `Get-CimInstance`: the former returns
 * `CreationDate` as the raw DMTF/CIM_DATETIME **string**
 * (`20261011170913.187772+480`) that {@link parseWmiCreationDate} is written for.
 * `Get-CimInstance` materializes it as a `System.DateTime` and renders it
 * through the *current culture* — measured `10/11/2026 17:10:05` under de-DE and
 * `2026年10月11日 17:09:13` under zh-CN — which is not the documented format, is
 * ambiguous between locales, and would make this answer depend on the
 * operator's regional settings. The DMTF string is culture-invariant.
 *
 * Structure notes, each one a defect shape already seen in this repo:
 *
 * - **`param` is the first statement.** A `param` block must lead the script
 *   block; anything before it is a parse error in Windows PowerShell 5.1.
 * - **The script is wrapped in `& { … }`** and `-TargetProcessId` follows the
 *   wrapper as separate argv elements. Everything after `-Command` is taken
 *   by `powershell.exe` as the command string plus arguments *to that
 *   string*, so a bare `param([int]$TargetProcessId)` script never binds a
 *   trailing `-TargetProcessId` — the binding defect fixed in
 *   `WINDOWS_POWERSHELL_QUERY_SCRIPT` (issue #88). The PID stays out of the
 *   command text.
 * - **The PID is typed `[int]`**, so the value interpolated into the WQL filter
 *   can only ever be a number.
 * - **Exit code 3 means the provider failed**, distinguishing "WMI is broken" from
 *   "no such process" (empty output, exit 0). Both end at `undefined` for the
 *   caller; the distinction is kept for diagnoseability.
 *
 * Exported for the real-spawn test, which runs this exact text through a real
 * `powershell.exe` so the argv-binding contract is proven against the
 * interpreter rather than against a mock's idea of it.
 */
export const WINDOWS_PROCESS_START_TIME_SCRIPT = [
  'param([int]$TargetProcessId)',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  '$ErrorActionPreference="Stop";',
  'try { $p = Get-WmiObject -Class Win32_Process -Filter "ProcessId=$TargetProcessId" -ErrorAction Stop } catch { [Console]::Error.Write("wmi query failed"); exit 3 };',
  'if ($null -eq $p) { exit 0 };',
  'if ($null -eq $p.CreationDate) { exit 0 };',
  '[Console]::Out.Write([string]$p.CreationDate)',
].join(' ')

/** Absolute path to a System32 tool, or `undefined` when SystemRoot is unset. */
function windowsSystemTool(relative: string): string | undefined {
  const systemRoot = process.env.SystemRoot?.trim()
  if (systemRoot === undefined || systemRoot === '') return undefined
  return join(systemRoot, relative)
}

/**
 * Run one Windows query and return its stdout, or `undefined` for *every*
 * failure: a missing SystemRoot, a spawn error, a non-zero exit (including a
 * timeout kill), or the `maxBuffer` ceiling. Never throws, and never falls
 * back to a PATH-resolved binary — "we could not tell" is the caller's
 * `undefined`, which degrades to plain PID liveness rather than to a wrong
 * answer.
 */
function runWindowsProcessQuery(binary: string | undefined, args: readonly string[]): string | undefined {
  if (binary === undefined) return undefined
  try {
    return execFileSync(binary, [...args], {
      encoding: 'utf8',
      timeout: WORKBUDDY_PROCESS_QUERY_STEP_TIMEOUT_MS,
      maxBuffer: WINDOWS_PROCESS_QUERY_MAX_OUTPUT_BYTES,
      windowsHide: true,
      // stderr is drained, not captured: PowerShell writes provider noise
      // there and it must not reach the host's own stderr.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

/**
 * Extract the `CreationDate` token from one tool's output, then parse it
 * strictly against {@link parseWmiCreationDate}.
 *
 * The trailing boundary is what keeps this from laundering malformed input
 * into a well-formed token: without it `...+4800` would be truncated to
 * `...+480`, which then passes the strict parser and silently yields a wrong
 * epoch. Require whitespace or end-of-output after the offset so a 4-digit
 * offset is rejected, not partially matched.
 */
function wmiCreationDateFromOutput(out: string): number | undefined {
  const token = out.match(/(\d{14})\.(\d+)([+-]\d{3})(?=\s|$)/)?.[0]
  if (token === undefined) return undefined
  return parseWmiCreationDate(token)
}

/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: an absolute `powershell.exe` runs
 *   {@link WINDOWS_PROCESS_START_TIME_SCRIPT}, which prints the CIM_DATETIME
 *   `CreationDate` — local fields plus a signed minute offset (see
 *   {@link parseWmiCreationDate}); the epoch it yields is comparable to
 *   `registeredAt`. If that stage yields no usable token, the absolute
 *   `wmic.exe` path is tried (kept for hosts where WMI answers but
 *   PowerShell does not). Both stages are bounded by
 *   {@link WORKBUDDY_PROCESS_QUERY_STEP_TIMEOUT_MS} and neither goes through PATH.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      // Primary: absolute powershell.exe + Get-WmiObject. Replaces the bare
      // `wmic` lookup, which was PATH-resolved, unbounded, and absent from
      // Windows 11 24H2 onward — see WINDOWS_PROCESS_START_TIME_SCRIPT.
      const viaPowershell = runWindowsProcessQuery(
        windowsSystemTool(WINDOWS_POWERSHELL_RELATIVE),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `& { ${WINDOWS_PROCESS_START_TIME_SCRIPT} }`,
          '-TargetProcessId',
          String(pid),
        ],
      )
      if (viaPowershell !== undefined) {
        const ms = wmiCreationDateFromOutput(viaPowershell)
        if (ms !== undefined) return ms
      }
      // Fallback: absolute wmic.exe, still never resolved through PATH.
      const viaWmic = runWindowsProcessQuery(
        windowsSystemTool(WINDOWS_WMIC_RELATIVE),
        ['process', 'where', `processid=${pid}`, 'get', 'CreationDate'],
      )
      return viaWmic === undefined ? undefined : wmiCreationDateFromOutput(viaWmic)
    }
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
    ).trim()
    if (out === '') return undefined
    const ms = Date.parse(out)
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it. A stale heartbeat (host crashed without clearing the file)
 * is distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A host
 *    that registered the heartbeat must have been started before writing it,
 *    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
 *    started after the host died, so `start > registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same PID
 * to an unrelated process, and the un-cleared stale heartbeat would otherwise
 * produce a false "Host running". When the process start time cannot be read
 * (e.g. unsupported platform) the check degrades to plain PID liveness.
 */
export function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean {
  try {
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startAtMs = processStartTimeMs(heartbeat.pid)
  if (startAtMs === undefined) return true // platform cannot read start time; PID alive is the best signal
  return startAtMs <= heartbeat.registeredAt
}
