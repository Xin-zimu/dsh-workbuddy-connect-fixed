/**
 * Owner-only file permissions, honestly enforced per platform.
 *
 * POSIX: the stores already write with `mode: 0o600`, which the kernel
 * enforces — nothing to do here.
 *
 * Windows: NTFS does not map POSIX mode bits (a `mode: 0o600` write lands as
 * 0o666 and access is decided purely by ACL inheritance from the parent
 * directory), so the "only the owner can read this" promise the credential
 * and state files document needs an explicit ACL tightening: strip inherited
 * ACEs and grant the current user full control, nothing else. That is what
 * `icacls <path> /inheritance:r /grant:r <account>:F` does.
 *
 * Two traps this module exists to avoid, both measured on Windows:
 *
 * 1. The account must be *domain-qualified*. `icacls` resolves a bare
 *    `<name>:F` by first trying `<name>` as a domain, so on a machine whose
 *    name equals the user name the grant is written as the malformed ACE
 *    `<machine>\:(F)` — an empty account, denying everyone, the owner
 *    included. `USERDOMAIN\USERNAME` is the form that resolves, and an
 *    unknown domain means "leave the ACL alone" rather than guess.
 * 2. `icacls` **exits 0** on that malformed grant and prints "Successfully
 *    processed 1 files" while doing it, so its exit status proves nothing
 *    about the result. A hardening step that locked the owner out of a
 *    credential file would be worse than the inherited ACL it replaced, so the
 *    ACL is verified by actually reopening the file and rolled back to
 *    inherited permissions (`/reset`) when the check fails.
 *
 * Resolved by absolute path from SystemRoot — never through PATH, the same
 * rule the discovery subprocesses follow, because PATH is user-writable.
 *
 * Best-effort by design: a preference or cache file that cannot be tightened
 * must not take the plugin down, and the stores' write paths already swallow
 * or report their own failures. The caller decides whether a `false` answer
 * is worth logging.
 *
 * @module dsh-workbuddy-connect/file-permissions
 */

import { execFileSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'

/** One `icacls` attempt is a local process on a small file; keep it short. */
const ICACLS_TIMEOUT_MS = 5_000

/** Absolute path to one System32 tool, or `undefined` without a SystemRoot. */
function system32(tool: string): string | undefined {
  const systemRoot = process.env.SystemRoot?.trim()
  if (systemRoot === undefined || systemRoot === '') return undefined
  return join(systemRoot, 'System32', tool)
}

/**
 * The current Windows user, domain-qualified for an unambiguous grant, or
 * `undefined` when it cannot be determined (service contexts without
 * USERDOMAIN/ USERNAME). Tightening to the wrong account would lock the plugin
 * out of its own file, so "unknown user" means "leave the ACL alone" — the
 * same rule the original bare-username form got wrong.
 *
 * Resolved once per process: neither variable changes under a running DSH.
 */
let accountSpec: string | undefined
let accountSpecResolved = false

function windowsAccountSpec(): string | undefined {
  if (accountSpecResolved) return accountSpec
  accountSpecResolved = true
  const domain = process.env.USERDOMAIN?.trim()
  const user = process.env.USERNAME?.trim()
  if (domain === undefined || domain === '' || user === undefined || user === '') return undefined
  // Quote/escape characters and separators would change how icacls parses the
  // spec; a name carrying them is not one this module can grant safely.
  const unsafe = (value: string): boolean => /["%\\]/.test(value)
  if (unsafe(domain) || unsafe(user)) return undefined
  accountSpec = `${domain}\\${user}`
  return accountSpec
}

/**
 * Whether the calling process can still open the file read-write.
 *
 * This is the only honest test of "did the tightening keep the file ours": the
 * `icacls` exit status does not report a malformed ACE, and reading the DACL
 * back would mean parsing localized, version-dependent `icacls` output.
 */
function ownerStillHasAccess(path: string): boolean {
  try {
    closeSync(openSync(path, 'r+'))
    return true
  } catch {
    return false
  }
}

/**
 * Enforce owner-only access on one already-written file.
 *
 * @param path - the file to tighten; it must exist.
 * @returns whether the platform enforcement succeeded (POSIX counts as
 * success: the write's `mode` already did the work). On Windows a `false`
 * answer also means the file was left with the permissions it had — a failed
 * tightening never leaves it less reachable than before.
 */
export function hardenFilePermissions(path: string): boolean {
  if (process.platform !== 'win32') return true
  const icacls = system32('icacls.exe')
  const account = windowsAccountSpec()
  if (icacls === undefined || account === undefined) return false
  const run = (args: readonly string[]): void => {
    // Quoting is via argv, not a shell, so an account name with spaces is safe.
    execFileSync(icacls, [...args], { timeout: ICACLS_TIMEOUT_MS, windowsHide: true, stdio: 'ignore' })
  }
  try {
    // /inheritance:r drops every inherited ACE; /grant:r replaces the DACL
    // with exactly one entry.
    run([path, '/inheritance:r', '/grant:r', `${account}:F`])
  } catch {
    return false
  }
  if (ownerStillHasAccess(path)) return true
  // The grant did not resolve to a usable ACE and the owner is locked out.
  // Put inherited permissions back so the file stays reachable, and report
  // failure rather than a promise the ACL does not keep.
  try {
    run([path, '/reset'])
  } catch {
    // Nothing further can be done here; the caller only sees `false`.
  }
  return false
}
