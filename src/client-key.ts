/**
 * Probe-control key delivery through the boot document (#4).
 *
 * The probe key is the only credential that authorizes spending the user's
 * credit, and the status route used to hand it to *any* loopback caller in its
 * response body. That is not a trust boundary: the gate on that route is
 * "Host names loopback and Origin is absent-or-loopback", and a local process
 * can write both headers as easily as the card can. On a host bound to
 * 0.0.0.0 the audience widens from "any local process" to the whole network
 * segment.
 *
 * Requiring a *present* Origin instead does not fix it either: browsers omit
 * Origin on same-origin GETs (which is exactly what the card sends), while a
 * local attacker forging the header is trivial — so that gate would break the
 * legitimate card and stop nothing.
 *
 * What is actually distinguishable is the *document*, not the request. The DSH
 * web index is not public: it is answered only to a caller holding the
 * process-launch token's browser cookie (see \`BrowserAuth.authorizeIndex\` in
 * @deepseek-ai/dsh-client-connection — a bare loopback GET to \`/\` gets 401),
 * and the desktop shell fetches the same rows over an IPC channel that
 * verifies the sender frame before answering. Handing the key to the index
 * instead of to the status body therefore reaches exactly the same pages while
 * reaching no local process that merely knows the port.
 *
 * The rows are emitted on every index render, so the value is read fresh at
 * emit time rather than captured once at startup.
 *
 * @module dsh-workbuddy-connect/client-key
 */

/** Global the boot document assigns the per-variant probe keys to. */
export const WORKBUDDY_PROBE_KEYS_GLOBAL = '__DSH_WORKBUDDY_PROBE_KEYS__'

/**
 * Read the probe keys the boot document injected, or \`undefined\` when this page
 * was not given any (an older host, a static worker deployment, or a card
 * rendered outside DSH).
 *
 * Deliberately tolerant: the value crosses a document boundary this module
 * does not own, so anything that is not the expected string map is treated as
 * "no key" and the controls that need one stay hidden, rather than throwing
 * inside a render.
 */
export function workBuddyProbeKeys(): Readonly<Record<string, string>> | undefined {
  const carrier = globalThis as Record<string, unknown>
  const value = carrier[WORKBUDDY_PROBE_KEYS_GLOBAL]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const keys: Record<string, string> = {}
  for (const [variant, key] of Object.entries(value as Record<string, unknown>)) {
    // A non-string would be coerced into the request header as "undefined";
    // dropping it leaves that variant's controls hidden instead.
    if (typeof key === 'string' && key !== '') keys[variant] = key
  }
  return Object.keys(keys).length === 0 ? undefined : keys
}

/**
 * The probe key for one variant, or \`undefined\` when this page holds none.
 *
 * Per-variant by construction: the map is keyed by variant id, so a card can
 * only ever present the key minted for the route it is about to POST to.
 */
export function workBuddyProbeKeyFor(variant: string): string | undefined {
  return workBuddyProbeKeys()?.[variant]
}
