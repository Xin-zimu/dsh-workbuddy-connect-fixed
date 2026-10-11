import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProbeKey, workBuddyProbeHandler } from '../src/probe-route.ts'
import { workBuddyStatusHandler } from '../src/web-status.ts'
import { WORKBUDDY_PROBE_KEYS_GLOBAL, workBuddyProbeKeyFor, workBuddyProbeKeys } from '../src/client-key.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog, type WorkBuddyModelInfo } from '../src/catalog.ts'
import { FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { CN_VARIANT, AI_VARIANT, WORKBUDDY_VARIANTS } from '../src/variants.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Issue #4: the probe key authorizes the one action that spends the user's
 * credit, and it used to be handed to any loopback caller in the status body.
 * That gate is not a trust boundary — it accepts a request that merely *claims*
 * to be loopback (\`Host: 127.0.0.1\`, no \`Origin\`), which any local process can
 * write, and on a host bound to 0.0.0.0 the audience is the whole network
 * segment.
 *
 * The key now travels through the boot document instead
 * (\`webserver/index-inject\`), which is answered only to a caller holding the
 * host's browser cookie. These tests pin both halves of that move: the status
 * route must not carry the key, and the injected map must be per-variant.
 */

const CLEANUP: (() => void)[] = []

afterEach(() => {
  for (const clean of CLEANUP.splice(0)) clean()
  vi.unstubAllEnvs()
  for (const key of Object.keys(globalThis as Record<string, unknown>)) {
    if (key === WORKBUDDY_PROBE_KEYS_GLOBAL) delete (globalThis as Record<string, unknown>)[key]
  }
})

/** One throwaway DSH_HOME holding a signed-in credential for \`variant\`. */
function signedInHome(variant: typeof CN_VARIANT | typeof AI_VARIANT): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-key-'))
  CLEANUP.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'auth.info')
  writeFileSync(file, JSON.stringify({
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3_600_000,
    domain: variant.region === 'global' ? 'www.workbuddy.ai' : 'copilot.tencent.com',
    uid: 'uid-key-test',
    nickname: 'key test',
  }))
  vi.stubEnv('DSH_HOME', dir)
  vi.stubEnv(variant.env, file)
  return dir
}

/** Mount the status route on a real loopback server and GET it. */
async function fetchStatus(variant: typeof CN_VARIANT | typeof AI_VARIANT): Promise<Record<string, unknown>> {
  signedInHome(variant)
  const store = new WorkBuddyCredentialStore({
    variant,
    refresh: async credential => ({ accessToken: credential.accessToken }),
  })
  const handler = workBuddyStatusHandler({
    path: variant.statusPath,
    store,
    client: { fetchCredits: async () => ({ total: 1, accounts: [] }) } as unknown as WorkBuddyUpstreamClient,
    models: () => new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS).current() as readonly WorkBuddyModelInfo[],
    probe: () => ({ consent: true, running: false, candidates: [], results: [] }),
  })
  const server: Server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const response = await fetch(`http://127.0.0.1:${String(port)}${variant.statusPath}`, {
    headers: { accept: 'application/json' },
  })
  return await response.json() as Record<string, unknown>
}

describe('#4 the probe key never rides the status document', () => {
  it('omits probeKey from a signed-in status body', async () => {
    const body = await fetchStatus(CN_VARIANT)
    expect(body['status']).toBe('signed-in')
    // The probe section is still served — only the credential moved.
    expect(body['probe']).toBeDefined()
    expect('probeKey' in body).toBe(false)
  })

  it('omits probeKey for the international variant too', async () => {
    const body = await fetchStatus(AI_VARIANT)
    expect(body['status']).toBe('signed-in')
    expect('probeKey' in body).toBe(false)
  })

  it('leaves the probe route refusing an unkeyed write', async () => {
    // The status body no longer discloses the key, so a caller that only read
    // the status route holds nothing that the write route accepts.
    const handler = workBuddyProbeHandler({
      path: '/probe',
      probe: async () => ({ state: 'ok' }),
      clear: () => {},
    }, createProbeKey())
    const server: Server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${String(port)}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: `127.0.0.1:${String(port)}` },
      body: JSON.stringify({ action: 'probe', model: 'glm-5.2' }),
    })
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('invalid-probe-key')
  })
})

describe('#4 injected key map', () => {
  it('reads back a per-variant map and resolves each variant independently', () => {
    ;(globalThis as Record<string, unknown>)[WORKBUDDY_PROBE_KEYS_GLOBAL] = {
      workbuddy: 'key-cn',
      'workbuddy-ai': 'key-ai',
    }
    expect(workBuddyProbeKeyFor(CN_VARIANT.id)).toBe('key-cn')
    expect(workBuddyProbeKeyFor(AI_VARIANT.id)).toBe('key-ai')
    // A variant the document says nothing about gets nothing: no fallback to
    // another variant's key, which is the cross-variant leak this map exists
    // to make impossible.
    expect(workBuddyProbeKeyFor('workbuddy-unknown')).toBeUndefined()
  })

  it('reports no keys when the boot document injected none', () => {
    expect(workBuddyProbeKeys()).toBeUndefined()
    expect(workBuddyProbeKeyFor(CN_VARIANT.id)).toBeUndefined()
  })

  it('ignores a malformed or empty injected value instead of throwing', () => {
    // The value crosses a document boundary this module does not own: a static
    // worker deployment or an older host may put anything here.
    for (const value of [undefined, null, 'key', 42, [], {}, { workbuddy: 42 }, { workbuddy: '' }]) {
      ;(globalThis as Record<string, unknown>)[WORKBUDDY_PROBE_KEYS_GLOBAL] = value
      expect(() => workBuddyProbeKeys()).not.toThrow()
      expect(workBuddyProbeKeyFor(CN_VARIANT.id)).toBeUndefined()
    }
  })
})
