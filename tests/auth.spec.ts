import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultDesktopAuthCandidates,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  WorkBuddyCredentialStore,
  WORKBUDDY_AUTH_FILE_ENV,
  type WorkBuddyCredential,
} from '../src/auth.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

// node:os's ESM namespace rejects vi.spyOn (non-configurable), so homedir is
// mocked at the module level; unset state falls through to the real one.
const fakeOs = vi.hoisted(() => ({
  home: undefined as string | undefined,
  release: undefined as string | undefined,
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => fakeOs.home ?? actual.homedir(),
    release: () => fakeOs.release ?? actual.release(),
  }
})

const CLEANUP: (() => Promise<void>)[] = []

/**
 * Tests below that fake a Linux/WSL platform must also construct POSIX
 * paths on a real filesystem: XDG overrides only apply to values starting
 * with `/`, and the WSL translation produces `/mnt/c/...` strings that are
 * meaningless — and unopenable — on a Windows runner. The platform stub
 * alone cannot make `join()` or the filesystem POSIX, so these cases run
 * only where the host path semantics match the platform under test. CI's
 * Windows leg skips them; its Ubuntu leg covers them.
 */
const POSIX_HOST = process.platform !== 'win32'

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

function nestedDoc(expiresAt: number): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: '昵称' },
  })
}

describe('parseWorkBuddyAuth', () => {
  it('reads the desktop nested form with millisecond expiry', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236_868))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.refreshToken).toBe('rt')
    expect(credential?.expiresAtMs).toBe(1_792_128_236_868)
    expect(credential?.uid).toBe('uid-1')
    expect(credential?.enterpriseId).toBe('ent-1')
    expect(credential?.nickname).toBe('昵称')
  })

  it('normalizes second-precision expiry to milliseconds', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236))
    expect(credential?.expiresAtMs).toBe(1_792_128_236_000)
  })

  it('reads the flat panel form', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 0,
      domain: '',
      uid: 'uid-2',
    }))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.uid).toBe('uid-2')
    expect(credential?.expiresAtMs).toBe(0)
  })

  it('rejects documents without an access token', () => {
    expect(parseWorkBuddyAuth('{}')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyAuth(JSON.stringify({ auth: { refreshToken: 'rt' } }))).toBeUndefined()
  })
})

function credentialWith(expiresAtMs: number): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'desktop',
  }
}

describe('WorkBuddyCredentialStore', () => {
  it('serves a fresh desktop credential without refreshing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 3600_000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'new' }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    expect(refreshes).toBe(0)
  })

  it('refreshes an expiring credential, persists the copy, and serves it next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    const own = join(dir, 'own.json')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async () => ({ accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh', source: 'dsh' })
    const saved = JSON.parse(await readFile(own, 'utf8')) as { version: number, credential: { accessToken: string } }
    expect(saved.version).toBe(1)
    expect(saved.credential.accessToken).toBe('fresh')
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })
  })

  it('still returns a not-yet-expired token when refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 60_000))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refreshMarginMs: 5 * 60_000,
      refresh: async () => {
        throw new Error('refresh endpoint down')
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('serves the persisted copy with its expiry and identity after the desktop file disappears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    const own = join(dir, 'own.json')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh', source: 'dsh' })
    await rm(desktop)
    const survived = await store.resolve()
    expect(refreshes).toBe(1)
    expect(survived).toMatchObject({ accessToken: 'fresh', uid: 'uid-1', enterpriseId: 'ent-1', nickname: '昵称', source: 'dsh' })
    expect(survived.expiresAtMs).toBeGreaterThan(Date.now() + 3000_000)
  })

  it('rejects an owned copy from another format version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const own = join(dir, 'own.json')
    await writeFile(own, JSON.stringify({ version: 99, credential: { accessToken: 'at' } }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'missing.info'),
      ownPath: own,
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).rejects.toThrow(/no signed-in WorkBuddy account/)
  })

  it('fails loudly when nothing is signed in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'missing.info'),
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).rejects.toThrow(/no signed-in WorkBuddy account/)
  })

  it('applies a desktop-path repoint on the next read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const first = join(dir, 'workbuddy-a.info')
    const second = join(dir, 'workbuddy-b.info')
    await writeFile(first, nestedDoc(Date.now() + 3600_000))
    await writeFile(second, JSON.stringify({
      auth: { accessToken: 'at-b', refreshToken: 'rt', expiresAt: Date.now() + 7200_000, domain: '' },
      account: { uid: 'uid-b', nickname: 'B' },
    }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: first,
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    store.setDesktopPath(second)
    expect(store.desktopAuthPath()).toBe(second)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-b', nickname: 'B' })
  })
})

/**
 * Owned-copy behaviour: removal, refresh lifetime, refresh coalescing, and the
 * failure modes of the copy itself.
 *
 * Every case here is about the plugin-owned file only. The desktop file is a
 * fixture these stores never write — which is the other half of the contract.
 */
describe('plugin-owned credential copy', () => {
  /** A desktop fixture that is always outside the refresh margin. */
  function freshDesktopDoc(): string {
    return nestedDoc(Date.now() + 3_600_000)
  }

  it('removes the credential on logout and leaves the lock file alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-logout-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const own = join(dir, 'own.json')
    const lock = `${own}.lock`
    // The copy logout must remove...
    await writeFile(own, JSON.stringify({ version: 1, credential: credentialWith(Date.now() + 3_600_000) }))
    // ...and the `<ownPath>.lock` sibling `withFileLock` serializes writers
    // through. It is created here rather than by a concurrent writer because
    // the invariant under test is about logout's own behaviour: deleting a lock
    // another process may be holding lets a third writer in, so the file has to
    // survive untouched.
    await writeFile(lock, JSON.stringify({ pid: process.pid }))
    const lockBefore = await stat(lock)

    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'absent.info'),
      ownPath: own,
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await store.logout()

    await expect(readFile(own, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const lockAfter = await stat(lock)
    // Still a regular file at the same path — not merely recreated. (The mtime
    // check needs sub-millisecond filesystem timestamps, hence the fallback.)
    expect(lockAfter.isFile()).toBe(true)
    expect(lockAfter.size).toBe(lockBefore.size)
    if (lockBefore.mtimeMs % 1 !== 0) expect(lockAfter.mtimeMs).toBe(lockBefore.mtimeMs)
    // Logging out twice is not an error: `force` is what makes it idempotent.
    await expect(store.logout()).resolves.toBeUndefined()
    // The desktop app's own sign-in was never touched.
    await expect(store.status()).resolves.toMatchObject({ state: 'signed-out', reasonCode: 'no-credential' })
  })

  it('does not need another refresh when the refresh answer states no lifetime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-no-lifetime-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    // Already expired: the first resolve must refresh.
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    const requests: string[] = []
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        requests.push('refresh')
        // No `expiresInSec`: the shape that used to inherit the old expiry.
        return { accessToken: `rotated-${requests.length}` }
      },
    })

    const first = await store.resolve()
    expect(requests).toHaveLength(1)
    expect(first.accessToken).toBe('rotated-1')
    // The regression: the old expiry was inherited, so it stayed inside the
    // margin and every later read refreshed again.
    expect(first.expiresAtMs).toBeGreaterThan(Date.now() + 5 * 60_000)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'rotated-1' })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'rotated-1' })
    expect(requests).toHaveLength(1)
    // And it is the copy that carries the derived lifetime, so a restart with
    // the desktop file gone does not go back to refreshing on every read.
    const saved = JSON.parse(await readFile(join(dir, 'own.json'), 'utf8')) as { credential: { expiresAtMs: number } }
    expect(saved.credential.expiresAtMs).toBeGreaterThan(Date.now() + 5 * 60_000)
  })

  it('follows an observed lifetime for later answers that state none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-observed-lifetime-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        // The first answer states a short-but-real lifetime; the second states
        // none. The second must be derived from what the upstream actually
        // issues (one hour), not from the compiled-in fallback (half of that).
        return refreshes === 1
          ? { accessToken: 'rotated-1', expiresInSec: 3600 }
          : { accessToken: `rotated-${refreshes}` }
      },
    })

    const first = await store.resolve()
    expect(first.expiresAtMs).toBeGreaterThan(Date.now() + 3500_000)
    // Force the second refresh through the same credential chain: winding the
    // stored copy's expiry back is exactly what a long-running process sees
    // when the hour is nearly up. The refresh token is unchanged, so this is
    // still the same chain.
    const own = JSON.parse(await readFile(join(dir, 'own.json'), 'utf8')) as { credential: { expiresAtMs: number } }
    own.credential.expiresAtMs = Date.now() - 1000
    await writeFile(join(dir, 'own.json'), JSON.stringify(own))
    // The desktop file is the identity authority and outranks the copy when its
    // uid differs; both fixtures carry the same one, so clear it to make the
    // copy the only credential in play.
    await rm(desktop)

    const second = await store.resolve()
    expect(refreshes).toBe(2)
    expect(second.accessToken).toBe('rotated-2')
    expect(second.expiresAtMs).toBeGreaterThan(Date.now() + 3500_000)
  })

  it('does not refresh again for a read that started before the refresh landed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-single-flight-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    const own = join(dir, 'own.json')
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async () => {
        refreshes += 1
        return { accessToken: `rotated-${refreshes}`, refreshToken: 'rt', expiresInSec: 3600 }
      },
    })

    // This read passes every check — the stored copy is expired — and then
    // *stalls on its own file read*, which is exactly the interleaving that
    // used to produce a second refresh: the copy is replaced while this read is
    // still in flight, so it hands `resolve` a credential that is already
    // stale. (The pause is injected into the read so the interleaving is
    // deterministic rather than a race the test would only sometimes hit.)
    const text = await readFile(desktop, 'utf8')
    let holdRead = false
    let releaseStaleRead: (() => void) | undefined
    const stalledRead = new Promise<void>(resolve => { releaseStaleRead = resolve })
    // `readDesktop` is private and therefore not on the public surface, and the
    // real one has to be captured *before* the spy replaces it — calling
    // `this.readDesktop()` from the mock would re-enter the mock.
    const proto = WorkBuddyCredentialStore.prototype as unknown as { readDesktop: () => Promise<unknown> }
    const realReadDesktop = proto.readDesktop
    const stalling = vi.spyOn(proto, 'readDesktop').mockImplementation(async function (this: unknown) {
      if (!holdRead) return await realReadDesktop.call(this)
      holdRead = false
      await stalledRead
      return { ...JSON.parse(text), expiresAtMs: Date.now() - 1000, source: 'desktop' }
    })

    try {
      holdRead = true
      const staleReader = store.resolve()
      // The refresh this read would have duplicated, landing first.
      const fresh = await store.resolve()
      expect(refreshes).toBe(1)
      expect(fresh.accessToken).toBe('rotated-1')

      // Without the re-read this launches a second round trip on a credential
      // the first one just replaced — and with a rotating refresh token that
      // second trip is not merely wasteful, it can end the session.
      releaseStaleRead?.()
      await expect(staleReader).resolves.toMatchObject({ accessToken: 'rotated-1', source: 'dsh' })
      expect(refreshes).toBe(1)
    } finally {
      stalling.mockRestore()
    }
  })

  it('refreshes the credential a concurrent sign-in replaced, not the stale one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-reread-switch-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    // Account A, expired and about to be replaced by a re-sign-in.
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    const own = join(dir, 'own.json')
    const refreshedFor: string[] = []
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async credential => {
        refreshedFor.push(credential.accessToken)
        return { accessToken: `rotated-${credential.accessToken}`, refreshToken: 'rt', expiresInSec: 3600 }
      },
    })

    // The read stalls while the desktop app signs in as B: the copy this call
    // holds is A's, and B's is on disk by the time it resumes.
    const aText = await readFile(desktop, 'utf8')
    const bDocument = JSON.stringify({
      auth: { accessToken: 'at-b', refreshToken: 'rt-b', expiresAt: Date.now() - 1000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-b', enterpriseId: 'ent-1', nickname: 'B' },
    })
    const proto = WorkBuddyCredentialStore.prototype as unknown as { readDesktop: () => Promise<unknown> }
    const realReadDesktop = proto.readDesktop
    let holdRead = false
    let release: (() => void) | undefined
    const held = new Promise<void>(resolve => { release = resolve })
    const stalling = vi.spyOn(proto, 'readDesktop').mockImplementation(async function (this: unknown) {
      if (!holdRead) return await realReadDesktop.call(this)
      holdRead = false
      await held
      // What the *stalled* read returns is A, the account that was signed in
      // when it started; the sign-in to B lands on disk behind it, so the
      // re-read inside `resolve` is what sees B.
      await writeFile(desktop, bDocument)
      return { ...JSON.parse(aText), expiresAtMs: Date.now() - 1000, source: 'desktop' }
    })

    try {
      holdRead = true
      const staleReader = store.resolve()
      await new Promise(resolve => setTimeout(resolve, 20))
      release?.()
      // B's turn is what the refresh must be spent on: A's token is no longer
      // signed in, and using it would answer as the wrong account.
      await expect(staleReader).resolves.toMatchObject({ uid: 'uid-b', source: 'dsh' })
      expect(refreshedFor).toEqual(['at-b'])
    } finally {
      stalling.mockRestore()
    }
  })

  it('shares one refresh between reads that overlap the round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-overlap-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    let releaseRefresh: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseRefresh = resolve })
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        await gate
        return { accessToken: 'rotated', expiresInSec: 3600 }
      },
    })

    const readers = Array.from({ length: 5 }, () => store.resolve())
    // Let every reader run up to the in-flight refresh before it can answer.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(refreshes).toBe(1)
    releaseRefresh?.()
    for (const credential of await Promise.all(readers)) {
      expect(credential).toMatchObject({ accessToken: 'rotated', source: 'dsh' })
    }
    expect(refreshes).toBe(1)
  })

  it('backs off after a failed refresh instead of retrying on every read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-backoff-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    // Inside the margin but still valid: the credential worth serving while the
    // endpoint is down.
    await writeFile(desktop, nestedDoc(Date.now() + 120_000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        throw new Error('refresh endpoint down')
      },
    })

    // The failure is absorbed: the stored token is still worth serving.
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    expect(refreshes).toBe(1)
    // The backoff window is what stops the storm.
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    expect(refreshes).toBe(1)
  })

  it('reports an unreadable plugin-owned copy instead of reading it as signed out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-own-unreadable-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const own = join(dir, 'own.json')
    // A directory where the copy should be: the `EISDIR`/`EACCES` class of
    // failure `readDesktop` already refuses to report as "nobody is signed in".
    await mkdir(own)
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'absent.info'),
      ownPath: own,
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.current()).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(store.resolve()).rejects.toMatchObject({ code: 'EISDIR' })
    // `status()` still never throws: it reports the failure as a diagnosable
    // signed-out state, naming the real cause rather than "sign in again".
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reason).toMatch(/EISDIR/)
  })

  it('treats a present-but-unusable plugin-owned copy as absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-own-unusable-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, freshDesktopDoc())
    const own = join(dir, 'own.json')
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    // Not JSON, a foreign format version, and a document with no access token:
    // each names no credential, so the desktop file answers. Only a *read*
    // failure propagates.
    for (const text of ['{ not json', JSON.stringify({ version: 99, credential: { accessToken: 'at' } }), JSON.stringify({ version: 1, credential: {} })]) {
      await writeFile(own, text)
      await expect(store.current()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    }
  })
})

describe('Windows default desktop path probing', () => {
  function windowsDoc(token: string): string {
    return JSON.stringify({
      auth: { accessToken: token, refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-w', nickname: 'Win 用户' },
    })
  }

  /** Fake a win32 home; probes are mocked in, dirs under a temp root. */
  async function fakeWindowsHome(): Promise<{ home: string, local: string, roaming: string }> {
    const home = await mkdtemp(join(tmpdir(), 'wb-win-'))
    CLEANUP.push(() => rm(home, { recursive: true, force: true }))
    const local = join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    const roaming = join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    return { home, local, roaming }
  }

  /** Run the case body as win32 with the given home; restore on exit. */
  async function asWindows<T>(home: string, run: () => Promise<T>): Promise<T> {
    const savedPlatform = process.platform
    const savedEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    delete process.env[WORKBUDDY_AUTH_FILE_ENV]
    fakeOs.home = home
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
      fakeOs.home = undefined
      if (savedEnv === undefined) delete process.env[WORKBUDDY_AUTH_FILE_ENV]
      else process.env[WORKBUDDY_AUTH_FILE_ENV] = savedEnv
    }
  }

  it('lists Local before Roaming on win32', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await asWindows(home, async () => {
      const candidates = defaultDesktopAuthCandidates()
      expect(candidates).toEqual([local, roaming])
    })
  })

  it('reads the Local AppData file when only it exists', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-local', source: 'desktop' })
      await expect(store.desktopFilePresent()).resolves.toBe(true)
    })
  })

  it('falls back to Roaming when only it exists (older desktop builds)', async () => {
    const { home, roaming } = await fakeWindowsHome()
    await mkdir(join(roaming, '..'), { recursive: true })
    await writeFile(roaming, windowsDoc('at-roaming'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-roaming', source: 'desktop' })
      await expect(store.desktopFilePresent()).resolves.toBe(true)
    })
  })

  it('prefers Local when both exist', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await mkdir(join(local, '..'), { recursive: true })
    await mkdir(join(roaming, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await writeFile(roaming, windowsDoc('at-roaming'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-local' })
    })
  })

  it('reports signed-out and lists both candidates when neither exists', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.status()).resolves.toMatchObject({ state: 'signed-out' })
      await expect(store.desktopFilePresent()).resolves.toBe(false)
      await expect(store.resolve()).rejects.toThrow(new RegExp(local.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)))
      await expect(store.resolve()).rejects.toThrow(/AppData.*Local[\s\S]*AppData.*Roaming/)
    })
  })

  it('uses an explicit desktopPath verbatim without probing on win32', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    const explicit = join(home, 'explicit.info')
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await writeFile(explicit, windowsDoc('at-explicit'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        desktopPath: explicit,
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-explicit' })
      expect(store.desktopAuthPath()).toBe(explicit)
      void roaming
    })
  })
})

describe('WSL default desktop path probing', () => {
  const AUTH_TAIL = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

  async function asWsl<T>(options: {
    home: string
    env?: Partial<Record<'APPDATA' | 'LOCALAPPDATA' | 'USERPROFILE', string>>
  }, run: () => Promise<T>): Promise<T> {
    const savedPlatform = process.platform
    const savedEnv = Object.fromEntries(
      ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'WSL_DISTRO_NAME', 'WSL_INTEROP']
        .map(name => [name, process.env[name]]),
    )
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    fakeOs.home = options.home
    fakeOs.release = '6.6.87.2-microsoft-standard-WSL2'
    delete process.env['APPDATA']
    delete process.env['LOCALAPPDATA']
    delete process.env['USERPROFILE']
    delete process.env['WSL_DISTRO_NAME']
    delete process.env['WSL_INTEROP']
    Object.assign(process.env, options.env)
    try {
      return await run()
    } finally {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
    fakeOs.home = undefined
    fakeOs.release = undefined
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** Run with the platform stubbed to a plain (non-WSL) Linux and a fixed home. */
async function asLinux<T>(options: {
  home: string
  env?: Record<string, string>
}, run: () => Promise<T>): Promise<T> {
  const savedPlatform = process.platform
  const managed = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'WSL_DISTRO_NAME', 'WSL_INTEROP']
  const savedEnv = Object.fromEntries(managed.map(name => [name, process.env[name]]))
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  fakeOs.home = options.home
  fakeOs.release = '6.12.0-generic'
  for (const name of managed) delete process.env[name]
  Object.assign(process.env, options.env)
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
    fakeOs.home = undefined
    fakeOs.release = undefined
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

  it('probes the matching mounted Windows profile before the Linux paths', async () => {
    await asWsl({ home: '/home/alice' }, async () => {
      expect(defaultDesktopAuthCandidates()).toEqual([
        join('/mnt/c/Users/alice/AppData/Local', AUTH_TAIL),
        join('/mnt/c/Users/alice/AppData/Roaming', AUTH_TAIL),
        join('/home/alice/.config', AUTH_TAIL),
        join('/home/alice/.local/share', AUTH_TAIL),
      ])
    })
  })

  it('probes both XDG bases on native Linux, config home before data home', async () => {
    await asLinux({ home: '/home/alice' }, async () => {
      expect(defaultDesktopAuthCandidates()).toEqual([
        join('/home/alice/.config', AUTH_TAIL),
        join('/home/alice/.local/share', AUTH_TAIL),
      ])
    })
  })

  it('honors non-empty absolute XDG overrides and falls back on invalid values', async () => {
    await asLinux({
      home: '/home/alice',
      env: { XDG_CONFIG_HOME: '/custom/config', XDG_DATA_HOME: '/custom/data' },
    }, async () => {
      expect(defaultDesktopAuthCandidates()).toEqual([
        join('/custom/config', AUTH_TAIL),
        join('/custom/data', AUTH_TAIL),
      ])
    })
    // A relative override is not a path the XDG spec allows, so it must not
    // be joined onto: both bases fall back to their defaults.
    await asLinux({
      home: '/home/alice',
      env: { XDG_CONFIG_HOME: 'relative/config', XDG_DATA_HOME: '  ' },
    }, async () => {
      expect(defaultDesktopAuthCandidates()).toEqual([
        join('/home/alice/.config', AUTH_TAIL),
        join('/home/alice/.local/share', AUTH_TAIL),
      ])
    })
  })

  it('swaps only the basename for the AI variant and still honors the env override', async () => {
    await asLinux({ home: '/home/alice' }, async () => {
      const aiTail = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
      expect(desktopAuthCandidatesFor(AI_VARIANT)).toEqual([
        join('/home/alice/.config', aiTail),
        join('/home/alice/.local/share', aiTail),
      ])
      // The explicit env override outranks every default candidate.
      vi.stubEnv(AI_VARIANT.env, '/explicit/ai-credential.info')
      const store = new WorkBuddyCredentialStore({
        variant: AI_VARIANT,
        ownPath: '/tmp/own.json',
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      expect(store.desktopAuthPath()).toBe('/explicit/ai-credential.info')
    })
  })

  it('skips an empty config-home file and resolves to the data-home credential', { skip: !POSIX_HOST }, async () => {
    // The probe treats an empty file as absent and moves on; the resolved-path
    // diagnostic must agree, or doctor would name the empty config-home file
    // while authentication actually uses the data-home candidate.
    const root = await mkdtemp(join(tmpdir(), 'wb-xdg-empty-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const configHome = join(root, 'config')
    const dataHome = join(root, 'data')
    const configAuth = join(configHome, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    const dataAuth = join(dataHome, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    await mkdir(configAuth, { recursive: true })
    await mkdir(dataAuth, { recursive: true })
    await writeFile(join(configAuth, 'workbuddy-desktop.info'), '   \n')
    await writeFile(join(dataAuth, 'workbuddy-desktop.info'), nestedDoc(Date.now() + 3600_000))
    await asLinux({ home: '/home/alice', env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome } }, async () => {
      const store = new WorkBuddyCredentialStore({
        variant: CN_VARIANT,
        ownPath: join(root, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolvedDesktopAuthPath()).resolves.toBe(join(dataAuth, 'workbuddy-desktop.info'))
      // And the probe really does authenticate from the data-home file.
      await expect(store.current()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    })
  })

  it('resolves the actually-hit path when only the data home carries the file', { skip: !POSIX_HOST }, async () => {
    // Issue #43 diagnostics: the first *candidate* is the config home, but
    // when only the data-home copy exists, resolvedDesktopAuthPath() must
    // name it — for both variants.
    const root = await mkdtemp(join(tmpdir(), 'wb-xdg-resolved-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const configHome = join(root, 'config')
    const dataHome = join(root, 'data')
    const dataAuth = join(dataHome, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    await mkdir(dataAuth, { recursive: true })
    await writeFile(join(dataAuth, 'workbuddy-desktop.info'), nestedDoc(Date.now() + 3600_000))
    await writeFile(join(dataAuth, 'workbuddy-desktop-ai.info'), nestedDoc(Date.now() + 3600_000))
    await asLinux({ home: '/home/alice', env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome } }, async () => {
      for (const variant of [CN_VARIANT, AI_VARIANT]) {
        const store = new WorkBuddyCredentialStore({
          variant,
          ownPath: join(root, `${variant.id}-own.json`),
          refresh: async credential => ({ accessToken: credential.accessToken }),
        })
        await expect(store.resolvedDesktopAuthPath()).resolves.toBe(
          join(dataAuth, variant.desktopFilename),
        )
      }
    })
  })

  it('uses translated WSL environment paths when the Windows user differs', { skip: !POSIX_HOST }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-wsl-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const windowsProfile = join(root, 'Users', 'windows-alice')
    const local = join(windowsProfile, 'AppData', 'Local', AUTH_TAIL)
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, nestedDoc(Date.now() + 3600_000))

    await asWsl({ home: '/home/linux-alice', env: { USERPROFILE: windowsProfile } }, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(root, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      expect(store.desktopAuthPath()).toBe(local)
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    })
  })

  it('converts Windows-form AppData environment paths to WSL mount paths', async () => {
    await asWsl({
      home: '/home/alice',
      env: {
        LOCALAPPDATA: String.raw`D:\Users\alice\AppData\Local`,
        APPDATA: String.raw`D:\Users\alice\AppData\Roaming`,
      },
    }, async () => {
      expect(defaultDesktopAuthCandidates().slice(0, 2)).toEqual([
        join('/mnt/d/Users/alice/AppData/Local', AUTH_TAIL),
        join('/mnt/d/Users/alice/AppData/Roaming', AUTH_TAIL),
      ])
    })
  })
})
