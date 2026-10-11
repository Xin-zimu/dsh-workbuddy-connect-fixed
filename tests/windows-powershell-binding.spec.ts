import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WINDOWS_POWERSHELL_QUERY_SCRIPT, workBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.ts'

/**
 * Real-spawn proof of the #88 fallback's argv binding (review follow-up).
 *
 * `tests/windows-registry-tool.spec.ts` mocks `execFile`, so it can only pin
 * the *shape* of the call; the reviewed defect — powershell.exe treating
 * everything after `-Command` as arguments to the command string, leaving
 * `param([string]$Root)` unbound — was invisible to it and made every
 * fallback run fail on the machines #88 exists to help. This spec runs the
 * production script through a real powershell.exe against a temporary HKCU
 * key carrying a Unicode `DisplayIcon`, and asserts:
 *
 * 1. the production invocation shape binds `$Root` and answers the registry
 *    document (exit 0, parseable JSON, Unicode intact);
 * 2. the pre-fix shape (bare script after `-Command`) does not — documenting
 *    the failure mode so a regression to it fails loudly;
 * 3. end-to-end through the real `workBuddyWindowsDiscoveryTools()`, the
 *    Unicode record survives `reg.exe` → fallback → re-encode (skipped on
 *    machines whose console code page makes `reg.exe` output ASCII-only,
 *    where the fallback correctly does not trigger).
 *
 * Windows-only: skipped everywhere else, and read/write confined to one
 * temporary `HKCU:\Software` key that is removed in `afterAll`.
 */

const HAS_POWERSHELL = process.platform === 'win32'
  && process.env.SystemRoot !== undefined && process.env.SystemRoot !== ''

const describeWin = HAS_POWERSHELL ? describe : describe.skip

const powershellPath = HAS_POWERSHELL
  ? join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : ''
const regPath = HAS_POWERSHELL ? join(process.env.SystemRoot!, 'System32', 'reg.exe') : ''

/**
 * One temporary root for the whole file; the values are what #88 is about.
 * Two spellings of the same key: the production roots are registry-provider
 * form (`HKCU\Software\…`, what `Registry::` prefixes), while the PowerShell
 * setup commands address it through the `HKCU:` drive.
 */
const TEST_LEAF = `wb-dsh-conn-binding-${process.pid.toString(16)}-${Date.now().toString(16)}`
const TEST_ROOT = `HKCU\\Software\\${TEST_LEAF}`
const TEST_ROOT_DRIVE = `HKCU:\\Software\\${TEST_LEAF}`
const UNICODE_PATH = 'C:\\人工智能\\WorkBuddy\\WorkBuddy.exe'
const DISPLAY_NAME = 'WorkBuddy 测试版'

function runPowerShell(args: readonly string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise(resolve => {
    execFile(powershellPath, [...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({
        code: error === null || error === undefined ? 0 : Number(error.code ?? 1),
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

/** Run a setup/cleanup script through -EncodedCommand: no quoting hazards. */
async function runScript(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const outcome = await runPowerShell(['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
  expect(outcome.code, `setup script failed: ${outcome.stderr}`).toBe(0)
}

function isAsciiOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) return false
  }
  return true
}

describeWin('issue #88 fallback: real powershell.exe binding', () => {
  beforeAll(async () => {
    await runScript(`
      $root = '${TEST_ROOT_DRIVE}'
      if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
      $sub = Join-Path $root 'TestApp'
      New-Item -Path $sub -Force | Out-Null
      New-ItemProperty -Path $sub -Name DisplayName -Value '${DISPLAY_NAME}' -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $sub -Name DisplayIcon -Value '"${UNICODE_PATH}",0' -PropertyType String -Force | Out-Null
    `)
  }, 60_000)

  afterAll(async () => {
    await runScript(`
      $root = '${TEST_ROOT_DRIVE}'
      if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    `)
  }, 60_000)

  it('binds $Root through the production scriptblock shape and returns the Unicode record', async () => {
    // Exactly the argv the fixed production code hands to powershell.exe.
    const outcome = await runPowerShell([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& { ${WINDOWS_POWERSHELL_QUERY_SCRIPT} }`,
      '-Root',
      TEST_ROOT,
    ])
    expect(outcome.code, `stderr: ${outcome.stderr}`).toBe(0)
    const rows = JSON.parse(outcome.stdout.trim()) as { displayName: string, displayIcon: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.displayName).toBe(DISPLAY_NAME)
    expect(rows[0]!.displayIcon).toBe(`"${UNICODE_PATH}",0`)
  }, 60_000)

  it('documents the pre-fix failure: a bare script after -Command never binds -Root', async () => {
    // The shape the review caught in production: script text, then `-Root`
    // and the value as separate argv elements. powershell.exe parses those as
    // positional leftovers, `$Root` stays empty, and the script dies on
    // `Registry::` — exit 2 (absent) or 3 (unreadable) depending on how the
    // empty provider path fails. Either way: non-zero, and no document.
    const outcome = await runPowerShell([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_POWERSHELL_QUERY_SCRIPT,
      '-Root',
      TEST_ROOT,
    ])
    expect(outcome.code).not.toBe(0)
    expect(() => JSON.parse(outcome.stdout.trim())).toThrow()
  }, 60_000)

  it('end-to-end: the real tools re-read a Unicode root through the fallback', async () => {
    // The production decision to fall back depends on reg.exe's raw bytes:
    // a console code page that renders CJK as '?' would make the output
    // ASCII-only and (correctly) skip the fallback entirely. Detect that
    // here rather than failing for an unrelated reason.
    const regBytes = await new Promise<Buffer>(resolve => {
      execFile(regPath, ['query', TEST_ROOT, '/s'], { encoding: 'buffer', windowsHide: true, timeout: 30_000 }, (_error, stdout) => {
        resolve(stdout ?? Buffer.alloc(0))
      })
    })
    if (isAsciiOnly(regBytes)) return // fallback legitimately not triggered on this code page

    const output = await workBuddyWindowsDiscoveryTools()
      .queryUninstallRoot(TEST_ROOT, new AbortController().signal)
    expect(output).toContain(UNICODE_PATH)
    expect(output).not.toContain('\uFFFD')
  }, 60_000)
})
