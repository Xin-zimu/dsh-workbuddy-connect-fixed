import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

/**
 * Guard the single-source-of-truth version contract:
 * - the build-time define injects package.json's version into src/version.ts;
 * - if that define is ever dropped, version.ts falls back to '0.0.0-dev' and
 *   this test goes red, flagging the regression (and the drift it would cause
 *   in heartbeat / CLI output).
 */
describe('package version sync', () => {
  it('WORKBUDDY_CONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(WORKBUDDY_CONNECT_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(WORKBUDDY_CONNECT_VERSION).not.toBe('0.0.0-dev')
  })

  /**
   * The define reads package.json at BUILD time, so a release that bumps the
   * version after building ships artifacts reporting the old one (issue #1:
   * v0.2.2 bundles said 0.2.1). Skipped on a fresh clone before the first build.
   *
   * The version literal may land in `index.js` or in a shared chunk beside it
   * (rollup decides which, and the chunk's hashed filename changes with the
   * module graph), so every emitted `.js` is scanned rather than one guessed
   * filename. Searching all of them is what keeps this guard meaningful: the
   * assertion is "the shipped artifacts carry this version", not "the bundle
   * was laid out this way".
   */
  it('built lib/ artifacts carry the current version when present', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const bundles = readdirSync(libDir).filter(name => name.endsWith('.js'))
    expect(bundles.length, 'no built bundles in lib/ — run the build before this test').toBeGreaterThan(0)
    const declaring = bundles.filter(bundle =>
      readFileSync(new URL(`../lib/${bundle}`, import.meta.url), 'utf8')
        .includes(`WORKBUDDY_CONNECT_VERSION = "${pkg.version}"`),
    )
    expect(
      declaring,
      `no built bundle declares WORKBUDDY_CONNECT_VERSION as "${pkg.version}" — rebuild before committing or publishing`,
    ).not.toHaveLength(0)
  })
})

describe('peer manifest pins the verified DSH cores', () => {
  /**
   * #69's lesson: a caret on a prerelease arm (`^0.2.0-rc.1`) silently
   * admits every later rc of the same tuple — semver auto-extends support
   * nobody verified. Since 0.7.0 the seven DSH service peers are pinned to
   * exactly the cores this release was smoke-tested on; extending support
   * means editing this list after a real run, not letting a caret do it.
   * Since 0.7.7 the list is 0.2.1-rc.1 alone: 0.2.0-rc.2 cannot be
   * smoke-tested anymore alongside it, and an untested arm is support
   * nobody verified.
   *
   * #74's lesson on top of it: pi-ai must NOT be a dual-arm range. An
   * in-place upgrade from a 0.6.x-era pnpm profile keeps satisfying
   * `^0.85.1 || ^0.87.1` with the old 0.85.1 install, reproducing #69's
   * two-generation mixing against an rc.2 host that ships 0.87.1.
   *
   * #92 extended that lesson one step further: even the caret-free `^0.87.1`
   * peer range was not enough, because a peer is only a claim about what the
   * *installer* should provide. pi-ai is therefore a pinned regular
   * dependency now; the assertion below pins that shape.
   */
  const DSH_SERVICE_PEERS = [
    '@deepseek-ai/dsh-atomic-write',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-settings',
  ] as const

  /**
   * The cores this release was actually smoke-tested on, as an exhaustive list.
   *
   * Enumerated, never a range. `>=0.2.1-rc.1 <0.2.2` and `^0.2.1-rc.1` both
   * admit `0.2.1-rc.3` and `0.2.2-rc.1`, which nobody ran here — the same
   * silent auto-extension #69 recorded. Adding a kernel to this list is a
   * deliberate edit made *after* a real run, which is exactly the property
   * this test exists to keep.
   *
   * rc.2 joined the list when DSH Desktop auto-updated to it and rejected
   * 0.7.7 at load time with "与 DSH 0.2.1-rc.2 不兼容". Compatibility was
   * established before widening, not assumed: devDependencies were moved to
   * 0.2.1-rc.2 so `tsc` checked against rc.2's own type surface, and the full
   * suite (857 passed, 7 skipped) ran on rc.2. The one host API that is absent
   * from rc.2 — `settings.installSection` — is absent from every 0.2.x core by
   * design, and the plugin probes for it at runtime and degrades.
   */
  const VERIFIED_DSH_CORES = ['0.2.1-rc.1', '0.2.1-rc.2'] as const

  it('each DSH service peer is an exact, caret-free list of verified cores', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
    // The literal the manifest must carry: the enumerated arms joined by `||`,
    // so the widening mechanism itself is caret- and `>=`-free.
    const expected = VERIFIED_DSH_CORES.join(' || ')
    for (const name of DSH_SERVICE_PEERS) {
      expect(pkg.peerDependencies[name], `${name} missing from peerDependencies`).toBe(expected)
    }
  })

  it('that peer range admits every verified core and nothing else', () => {
    // Without this, the assertion above would only pin a string: a typo that
    // silently admits or excludes a core would still match a hand-edited
    // expectation. This checks the *shape* of the literal, which is the part
    // that decides what a host sees.
    //
    // Deliberately not resolved with `semver`: that package is not a
    // dependency here, and adding one so a test can restate what `||` means
    // would grow the shipped footprint to prove a property of a string. The
    // two shapes that could silently auto-extend support are ruled out
    // directly instead — a `^`/`~`/`>=` arm, or a single arm, would each admit
    // cores nobody ran.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
    for (const name of DSH_SERVICE_PEERS) {
      const range = pkg.peerDependencies[name]!
      // Exactly one arm per verified core, and every arm an exact version.
      const arms = range.split('||').map(arm => arm.trim())
      expect(arms, `${name} must enumerate exactly the verified cores`).toEqual([...VERIFIED_DSH_CORES])
      for (const arm of arms) {
        expect(arm, `${name} arm "${arm}" must be an exact version, not a range`)
          .toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
      }
      // No arm may be a caret, tilde, comparator, wildcard, or `x`-range: each
      // of those would admit a core this release never ran against.
      expect(range, `${name} must not widen with ^ ~ > < = * or x`).not.toMatch(/[\^~><=*]|\bx\b/iu)
    }
  })

  it('pi-ai is a pinned runtime dependency, not a peer', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    // #92's lesson, on top of #74's: a peer declaration cannot survive a
    // hoisted profile. With `nodeLinker: hoisted` and `autoInstallPeers:
    // false`, no install claims our peer, so a co-installed plugin's older
    // pi-ai at the profile root wins bare-specifier resolution and the plugin
    // loads the wrong generation. A regular dependency installs beside the
    // plugin and resolves first, whatever the profile root holds.
    expect(pkg.dependencies?.['@earendil-works/pi-ai']).toBe('1.3.0')
    expect(
      pkg.peerDependencies['@earendil-works/pi-ai'],
      'pi-ai must not also be a peer: a peer declaration is what allowed the hoisted copy to win',
    ).toBeUndefined()
    // The dev entry keeps local builds and tests on the same generation, and
    // stays exact so no caret can widen the supported set by itself.
    expect(pkg.devDependencies['@earendil-works/pi-ai']).toBe('1.3.0')
  })
})
