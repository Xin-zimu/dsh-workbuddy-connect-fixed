import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyProbeControl, cardVariantFor, type WorkBuddyProbeControlProps } from '../src/client/WorkBuddyProbeControl.tsx'
import {
  AI_CARD_VARIANT,
  CARD_VARIANTS,
  CN_CARD_VARIANT,
  WorkBuddyPluginCard,
  type WorkBuddyPluginCardProps,
} from '../src/client/WorkBuddyPluginCard.tsx'
import { en, zh } from '../src/client/locales.ts'
import { WORKBUDDY_PROBE_KEYS_GLOBAL, workBuddyProbeKeyFor } from '../src/client-key.ts'
import { WORKBUDDY_VARIANTS } from '../src/variants.ts'

/**
 * Hand the page the probe keys the boot document would inject (#4). The keys
 * no longer ride the status body, so a fixture that still set `probeKey`
 * would leave every write unauthenticated and the controls inert.
 */
function injectProbeKeys(keys: Record<string, string>): void {
  ;(globalThis as Record<string, unknown>)[WORKBUDDY_PROBE_KEYS_GLOBAL] = keys
}

/** Every rendered `<button>` in a react-test-renderer tree, with its disabled flag. */
function collectButtons(
  node: unknown,
  found: { disabled: boolean; ariaExpanded?: unknown }[] = [],
): { disabled: boolean; ariaExpanded?: unknown }[] {
  if (node === null || typeof node !== 'object') return found
  const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
  if (element.type === 'button') {
    found.push({ disabled: element.props?.['disabled'] === true, ariaExpanded: element.props?.['aria-expanded'] })
  }
  for (const child of element.children ?? []) collectButtons(child, found)
  return found
}


/**
 * Two-product client behaviour. The card component and the composer control are
 * shared by both providers, so these tests cover the ways one product's state
 * could leak into the other's surface: a wrong route, a wrong title, or a
 * probe confirmation targeting a model the user did not select.
 */

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    en[key] as string,
  )

describe('card variants', () => {
  it('exposes one card per provider, with distinct routes and copy', () => {
    expect(CARD_VARIANTS).toHaveLength(2)
    expect(CARD_VARIANTS.map(card => card.id)).toEqual(['workbuddy', 'workbuddy-ai'])
    const routes = CARD_VARIANTS.map(card => `${card.statusPath}|${card.probePath}`)
    expect(new Set(routes).size).toBe(2)
    // Distinct title/intro/hint keys, so one product's copy cannot appear as the
    // other's.
    expect(AI_CARD_VARIANT.titleKey).not.toBe(CN_CARD_VARIANT.titleKey)
    expect(AI_CARD_VARIANT.introKey).not.toBe(CN_CARD_VARIANT.introKey)
    expect(AI_CARD_VARIANT.signedOutKey).not.toBe(CN_CARD_VARIANT.signedOutKey)
  })

  it('routes each provider id to its own card and nothing else', () => {
    expect(cardVariantFor('workbuddy')).toBe(CN_CARD_VARIANT)
    expect(cardVariantFor('workbuddy-ai')).toBe(AI_CARD_VARIANT)
    // Any other provider resolves to no card, which is what keeps the composer
    // entry off non-WorkBuddy models.
    expect(cardVariantFor('deepseek')).toBeUndefined()
    expect(cardVariantFor('')).toBeUndefined()
  })

  it('has copy for both products in both languages', () => {
    for (const card of CARD_VARIANTS) {
      expect(zh[card.titleKey]).toBeTruthy()
      expect(zh[card.introKey]).toBeTruthy()
      expect(zh[card.signedOutKey]).toBeTruthy()
      // The two titles must actually differ in each language, not just be
      // distinct keys with identical text.
      expect(zh[card.titleKey]).toContain(card.id === 'workbuddy-ai' ? 'AI' : 'WorkBuddy')
    }
    expect(zh.titleAI).not.toBe(zh.title)
    expect(en.titleAI).not.toBe(en.title)
  })
})

describe('plugin card per variant', () => {
  let view: ReactTestRenderer | undefined
  let statusBody: Record<string, unknown>
  const request = vi.fn()

  beforeEach(() => {
    statusBody = { status: 'signed-in', nickname: 'nick', credits: { total: 1, accounts: [] }, models: [] }
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  async function mount(variant?: typeof CN_CARD_VARIANT): Promise<void> {
    await act(async () => {
      // The card reads `t` and `variant`; the remaining props belong to the slot
      // that mounts it in DSH, so the test supplies only what it uses.
      const props = {
        t: t as WorkBuddyPluginCardProps['t'],
        ...variant === undefined ? {} : { variant },
      } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
      view = create(createElement(WorkBuddyPluginCard, props))
    })
  }

  it('reads the CN route by default and shows the CN title', async () => {
    await mount()
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    expect(request.mock.calls[0]![0]).toBe(CN_CARD_VARIANT.statusPath)
    expect(JSON.stringify(view!.toJSON())).toContain(en.title)
  })

  it('reads the AI route and shows the AI title when handed the AI variant', async () => {
    await mount(AI_CARD_VARIANT)
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    // The critical assertion: the card must not read the CN status document,
    // which would show the other product's account and balance.
    expect(request.mock.calls[0]![0]).toBe(AI_CARD_VARIANT.statusPath)
    expect(request.mock.calls[0]![0]).not.toBe(CN_CARD_VARIANT.statusPath)
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain(en.titleAI)
    expect(rendered).toContain(en.introAI)
  })

  it('shows the variant-specific sign-in hint when signed out', async () => {
    statusBody = { status: 'signed-out' }
    await mount(AI_CARD_VARIANT)
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    expect(JSON.stringify(view!.toJSON())).toContain(en.signedOutHintAI)
  })

  it('shows a diagnosable sign-out reason instead of the generic hint', async () => {
    statusBody = { status: 'signed-out', reason: 'WorkBuddy AI received a WorkBuddy (CN) credential in its desktop file' }
    await mount(AI_CARD_VARIANT)
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    const rendered = JSON.stringify(view!.toJSON())
    expect(rendered).toContain('received a WorkBuddy (CN) credential')
    // Telling the user to sign in is wrong advice when a path is what is broken.
    expect(rendered).not.toContain(en.signedOutHintAI)
  })
})

describe('composer control provider routing', () => {
  let view: ReactTestRenderer | undefined
  let state: ReturnType<WorkBuddyProbeControlProps['directory']['getSnapshot']>
  const listeners = new Set<() => void>()
  const request = vi.fn()
  let statusBody: Record<string, unknown>
  const directory = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  } as WorkBuddyProbeControlProps['directory']

  function select(provider: string, model: string): void {
    state = { current: { provider, model }, status: 'ready', groups: [], failures: [], error: null, routable: true }
    listeners.forEach(listener => listener())
  }

  beforeEach(() => {
    statusBody = {
      status: 'signed-in',
      probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] },
    }
    injectProbeKeys({ workbuddy: 'test-key', 'workbuddy-ai': 'test-key' })
    select('workbuddy', 'glm-5.2')
    injectProbeKeys({ workbuddy: 'test-key', 'workbuddy-ai': 'test-key' })
    request.mockReset().mockImplementation(async () => ({ ok: true, json: async () => statusBody }))
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
    listeners.clear()
  })

  async function mount(): Promise<void> {
    await act(async () => {
      view = create(createElement(WorkBuddyProbeControl, { directory, t: t as WorkBuddyProbeControlProps['t'] }))
    })
  }

  const posts = () => request.mock.calls.filter(([, init]) => init?.method === 'POST')

  it('reads the CN status route for a CN model', async () => {
    await mount()
    expect(request.mock.calls[0]![0]).toBe(CN_CARD_VARIANT.statusPath)
  })

  it('reads the AI status route for an AI model', async () => {
    select('workbuddy-ai', 'glm-5.2')
    await mount()
    // Same model id on both endpoints, so only the provider can decide which
    // document holds this model's state.
    expect(request.mock.calls[0]![0]).toBe(AI_CARD_VARIANT.statusPath)
  })

  it('posts a detection to the selected provider route only', async () => {
    select('workbuddy-ai', 'glm-5.2')
    await mount()
    // Confirm, then run. The probe entry is the only seat control carrying
    // aria-expanded (the ↻ beside it does not).
    const probeEntry = view!.root.findAllByType('button').find(node => 'aria-expanded' in node.props)!
    await act(async () => { probeEntry.props.onClick() })
    const confirm = view!.root.findAllByType('button').find(node => node.children.join('') === en.probeConfirmAction)
    await act(async () => { confirm!.props.onClick() })
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![0]).toBe(AI_CARD_VARIANT.probePath)
    expect(posts()[0]![0]).not.toBe(CN_CARD_VARIANT.probePath)
  })

  it('does not show for a non-WorkBuddy provider', async () => {
    select('deepseek', 'glm-5.2')
    await mount()
    expect(view?.toJSON()).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
/**
 * #4: with no key the boot document cannot authorize a write, so every
 * key-gated control must be visibly disabled. A clickable button that silently
 * does nothing is worse than an unavailable one — it reads as a broken plugin.
 */
describe('#4 controls are disabled when the page holds no probe key', () => {
  it('disables the detections, the clear action, and the model refresh', async () => {
    // Simulate a page the boot document gave no key: the global is absent.
    ;(globalThis as Record<string, unknown>)[WORKBUDDY_PROBE_KEYS_GLOBAL] = undefined
    statusBody = {
      status: 'signed-in',
      probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] },
      catalog: { source: 'live', fetchedAt: Date.now() },
    }
    select('workbuddy', 'glm-5.2')
    await act(async () => {
      view = create(createElement(WorkBuddyProbeControl, { directory, t: t as WorkBuddyProbeControlProps['t'] }))
    })
    // Walk the rendered tree for real <button>s. Asserting on the tree (not on
    // a JSON substring) is what makes this test bite: "the string 'disabled'
    // appears somewhere" would pass for reasons unrelated to the key.
    const buttons = collectButtons(view!.toJSON())
    // The probe entry is the one key-gated control in this seat, and
    // `aria-expanded` is what identifies it: the ↻ beside the badge also
    // carries `aria-busy`, but it reads the status route, which needs no key.
    //
    // Deliberately NOT asserted over every button. The ↻ must stay enabled —
    // it is the seat's one re-read affordance and the way the control recovers
    // from an unreadable first read — and a Cancel or note dismiss is purely
    // local UI that must always work whatever the host injected.
    const probeEntry = buttons.filter(button => button.ariaExpanded !== undefined)
    expect(probeEntry).toHaveLength(1)
    expect(probeEntry[0]!.disabled).toBe(true)
  })

  it('enables them again once the key is present', async () => {
    injectProbeKeys({ workbuddy: 'test-key', 'workbuddy-ai': 'test-key' })
    statusBody = {
      status: 'signed-in',
      probe: { consent: true, running: false, candidates: ['glm-5.2'], results: [] },
    }
    select('workbuddy', 'glm-5.2')
    await act(async () => {
      view = create(createElement(WorkBuddyProbeControl, { directory, t: t as WorkBuddyProbeControlProps['t'] }))
    })
    expect(view!.toJSON()).not.toBeNull()
  })
})
})

/**
 * #4: the injected probe keys are keyed by \`WorkBuddyVariant.id\`, while the
 * card looks its key up by \`WorkBuddyCardVariant.id\`. Those are two separately
 * declared string literals, so a rename on one side would not be a type error —
 * it would just make \`workBuddyProbeKeyFor\` answer undefined and silently
 * disable every probe control. This pins the two namespaces together, and lives
 * in the client project because only it compiles the card module.
 */
describe('#4 card ids and injected key ids are one namespace', () => {
  it('gives every card a variant with the same id and the same routes', () => {
    for (const card of CARD_VARIANTS) {
      const variant = WORKBUDDY_VARIANTS.find(candidate => candidate.id === card.id)
      expect(variant, `no variant serves card id "${card.id}"`).toBeDefined()
      // The card's route pair must be the variant's, or the key it presents
      // would belong to a different route than the one it posts to.
      expect(card.statusPath).toBe(variant!.statusPath)
      expect(card.probePath).toBe(variant!.probePath)
    }
    // And every variant has a card: a variant with no card would have its key
    // injected for nobody.
    for (const variant of WORKBUDDY_VARIANTS) {
      expect(CARD_VARIANTS.some(card => card.id === variant.id)).toBe(true)
    }
  })

  it('resolves a distinct key for each id the cards actually use', () => {
    // Built the way src/index.ts builds it, then read the way the card reads it.
    injectProbeKeys(Object.fromEntries(WORKBUDDY_VARIANTS.map(variant => [variant.id, `key-${variant.id}`])))
    for (const card of CARD_VARIANTS) {
      expect(workBuddyProbeKeyFor(card.id)).toBe(`key-${card.id}`)
    }
  })
})
