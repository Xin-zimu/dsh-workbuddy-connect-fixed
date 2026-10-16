import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hardenFilePermissions } from '../src/file-permissions.ts'

/**
 * Issue #6: the stores document their state and credential files as
 * owner-only. On POSIX the `mode: 0o600` the call sites pass is enforced by
 * the kernel; NTFS does not map POSIX mode bits at all, so on Windows that
 * promise is kept only by an explicit ACL tightening. These tests pin the half
 * of the contract the running platform can actually judge, and never claim the
 * other half.
 *
 * The Windows cases run the real `icacls` through the production path — no
 * mock — because the whole point of the module is that the ordinary-mode write
 * does NOT deliver this on Windows, and because `icacls` reports success for
 * ACEs that deny the owner access. A mocked `icacls` would pin the argument
 * shape and miss exactly the defect these tests were written for.
 */

const CLEANUP: (() => void)[] = []

afterEach(() => {
  for (const clean of CLEANUP.splice(0)) clean()
})

/** A throwaway directory removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-perm-'))
  CLEANUP.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Absolute `icacls.exe`, or `undefined` outside a Windows SystemRoot. */
function icacls(): string | undefined {
  const root = process.env.SystemRoot?.trim()
  return root === undefined || root === '' ? undefined : join(root, 'System32', 'icacls.exe')
}

/** The file's DACL as `icacls` prints it, or `undefined` when unavailable. */
function dacl(path: string): string | undefined {
  const bin = icacls()
  if (bin === undefined) return undefined
  try {
    return execFileSync(bin, [path], { encoding: 'utf8', windowsHide: true })
  } catch {
    return undefined
  }
}

/** Whether the current process can still open the file read-write. */
function ownerCanOpen(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Principals that must never appear in a hardened file's DACL.
 *
 * Named as the plain text `icacls` prints — `Everyone`, not `\\Everyone`. This
 * value is asserted against real principals below, before it is used, because
 * an over-escaped alternative is invisible: `/\\\\Everyone/` compiles to the
 * literal `\\Everyone`, which no `icacls` output ever contains, so that branch
 * silently matches nothing and the assertion keeps passing while a world-
 * readable ACE sits in the DACL. That is exactly the shape this constant was
 * in before it was checked.
 *
 * `BUILTIN\Users` and `Authenticated Users` are the unprivileged groups;
 * `Everyone` is the world. `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators`
 * are deliberately NOT listed: Windows keeps them as explicit entries after
 * `/inheritance:r /grant:r`, and neither is reachable by another unprivileged
 * user, so their presence is not the leak this hardening closes.
 */
const LEAKED_PRINCIPALS = /BUILTIN\\Users|Everyone|Authenticated Users/iu

/**
 * Real `icacls` DACL lines, one per alternative in {@link LEAKED_PRINCIPALS}.
 *
 * Each must be matched, and the benign entries below must not be. Without this
 * the security assertion is unfalsifiable: a pattern that matches none of the
 * principals it names would still make every hardening test pass.
 */
const LEAK_SAMPLES = [
  'C:\\state.json Everyone:(R)',
  'C:\\state.json BUILTIN\\Everyone:(R)',
  'C:\\state.json BUILTIN\\Users:(RX)',
  'C:\\state.json Authenticated Users:(M)',
] as const

/** Owner-only and administrative entries a hardened DACL legitimately carries. */
const BENIGN_SAMPLES = [
  'C:\\state.json xin\\xin:(F)',
  'C:\\state.json NT AUTHORITY\\SYSTEM:(F)',
  'C:\\state.json BUILTIN\\Administrators:(F)',
] as const

describe('the leak assertion itself', () => {
  it('matches every leaked principal and none of the benign ones', () => {
    // Guards the guard: this is what makes the hardening test below meaningful.
    // An over- or under-escaped alternative fails here rather than silently
    // weakening the security assertion on a platform most runs never touch.
    for (const sample of LEAK_SAMPLES) {
      expect(LEAKED_PRINCIPALS.test(sample), `${sample} must be treated as a leak`).toBe(true)
    }
    for (const sample of BENIGN_SAMPLES) {
      expect(LEAKED_PRINCIPALS.test(sample), `${sample} must not be treated as a leak`).toBe(false)
    }
  })
})

const WINDOWS_ONLY = process.platform === 'win32'

describe('hardenFilePermissions', () => {
  it('reports success for a POSIX write, whose mode already did the work', () => {
    if (WINDOWS_ONLY) return
    const path = join(tempDir(), 'state.json')
    writeFileSync(path, '{}\n', { mode: 0o600 })
    expect(hardenFilePermissions(path)).toBe(true)
    expect((statSync(path).mode & 0o777) & 0o077).toBe(0)
  })

  it.runIf(WINDOWS_ONLY)('replaces the inherited DACL with one owner-only entry', () => {
    const path = join(tempDir(), 'state.json')
    writeFileSync(path, '{}\n', { mode: 0o600 })
    const before = dacl(path)
    if (before === undefined) return // no icacls here: nothing to assert

    expect(hardenFilePermissions(path)).toBe(true)

    const after = dacl(path)
    expect(after).toBeDefined()
    // The claim this module makes is narrower than "one ACE and nothing else":
    // it strips *inherited* ACEs and grants the owner full control. Windows
    // keeps SYSTEM and BUILTIN\\Administrators as explicit entries, and on a
    // CI runner both were still present after hardening — neither is reachable
    // by another unprivileged user. Asserting their absence passed on a dev box
    // (whose parent directory granted them only by inheritance) and failed on CI.
    //
    // What must hold: nothing is left INHERITED, and no world/Users-group entry
    // survives — the actual leak this hardening exists to close.
    // `LEAKED_PRINCIPALS` is itself asserted against real principal spellings
    // above, so this pair cannot pass by matching nothing.
    expect(after).not.toMatch(/\(I\)/)
    expect(after).not.toMatch(LEAKED_PRINCIPALS)
    const user = process.env.USERNAME?.trim()
    if (user !== undefined && user !== '') expect(after).toContain(user)
    // The owner's grant is full control.
    expect(after).toMatch(/\(F\)/)
  })

  it.runIf(WINDOWS_ONLY)(
    'never leaves the owner locked out of a file it reports as hardened',
    () => {
      // The defect this guards: `icacls <path> /inheritance:r /grant:r <user>:F`
      // with a bare user name resolves the name as a *domain* when the machine
      // is named like the user, writes the malformed ACE `<machine>\:(F)`, and
      // still exits 0. The owner then cannot open their own credential file.
      // Whatever form the module uses, a `true` answer must mean the file is
      // still ours.
      const path = join(tempDir(), 'state.json')
      writeFileSync(path, '{"token":"secret"}\n', { mode: 0o600 })
      const hardened = hardenFilePermissions(path)
      expect(ownerCanOpen(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('secret')
      if (hardened) expect(dacl(path)).not.toMatch(/\\\s*:\(/u)
    },
  )

  it.runIf(WINDOWS_ONLY)('leaves an unhardened file reachable when it cannot grant', () => {
    // "Best effort" must not mean "reports success anyway": a `false` answer
    // has to come with the file still readable by its owner, or a failed
    // tightening would be worse than the inherited ACL it replaced.
    const path = join(tempDir(), 'state.json')
    writeFileSync(path, '{}\n', { mode: 0o600 })
    const result = hardenFilePermissions(path)
    expect(typeof result).toBe('boolean')
    expect(ownerCanOpen(path)).toBe(true)
  })
})
