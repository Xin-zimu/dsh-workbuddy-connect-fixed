import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface Harness {
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  upstreamBodies: string[]
  upstreamResponse: () => WorkBuddyChatResult
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function rawRequest(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function startShim(upstreamResponse: () => WorkBuddyChatResult): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-shim-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1' },
  }))
  const store = new WorkBuddyCredentialStore({
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const harness: Harness = {
    shim: undefined as unknown as WorkBuddyShim,
    store,
    upstreamBodies: [],
    upstreamResponse,
  }
  harness.shim = createWorkBuddyShim({
    store,
    catalog: new WorkBuddyCatalog(),
    client: {
      async chatStream(_credential, bodyJson): Promise<WorkBuddyChatResult> {
        harness.upstreamBodies.push(bodyJson)
        return harness.upstreamResponse()
      },
    },
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

describe('WorkBuddy shim', () => {
  it('lists the catalog on /v1/models', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string }[] }
    const ids = body.data.map(model => model.id)
    expect(ids).toContain('hy3')
    expect(ids).toContain('deepseek-v4-pro')
    // The fallback roster tracks the live `cli` agent's 16 models.
    expect(ids.length).toBe(16)
    expect(ids).toContain('hy4-preview')
    expect(ids).toContain('glm-5.3')
  })

  it('streams a successful chat completion and normalizes the body', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'hy3',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'auto' },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('你好')
    expect(text).toContain('[DONE]')
    expect(harness.upstreamBodies.length).toBe(1)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['stream']).toBe(true)
    expect(forwarded['tool_choice']).toBe('auto')
  })

  it('forwards the reasoning_effort a model picker selection sends', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['reasoning_effort']).toBe('xhigh')
    expect(forwarded['stream']).toBe(true)
  })

  it('maps an upstream credit failure onto HTTP 402', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: '积分不足',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(response.status).toBe(402)
    const body = await response.json() as { error: { type: string, message: string } }
    expect(body.error.type).toBe('hard_credit')
    expect(body.error.message).toContain('积分不足')
  })

  it('answers unknown routes with 404', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/nothing`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(404)
  })

  it('binds loopback only', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    expect(harness.shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // A rebinding page resolves evil.com to 127.0.0.1; the browser then sends
    // Host: evil.com:<port>. fetch() forbids overriding Host, so use raw http.
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('host_not_allowed')
  })

  it('accepts Host with a loopback name plus port', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a browser Origin from a non-loopback site', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('origin_not_allowed')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('accepts a loopback browser Origin', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects a chat POST with a non-JSON Content-Type (simple-request CSRF)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(415)
    expect(res.body).toContain('unsupported_media_type')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request without a bearer (local process without the secret)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // Everything else about this request is legitimate: loopback Host, no
    // Origin (a local process, not a browser), JSON body. Only the bearer is
    // missing — this is the shape a hostile local process would send.
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(res.body).toContain('unauthorized')
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request with a wrong bearer', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer not-the-real-secret',
      },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(harness.upstreamBodies).toHaveLength(0)
  })
})

describe('SSE lifecycle', () => {
  /**
   * Cancellation: the shim must abort the upstream request when the client
   * disconnects, *including* when the disconnect happens after the request
   * body was already fully read. `req.on('close')` registered after
   * `await readBody(req)` never fires (the stream is destroyed and `close`
   * already emitted), which left "stop" unable to cancel the upstream call
   * — it kept generating and billing. The fix rides `res`'s close instead;
   * these pins drive a real socket and observe the signal the shim passes
   * to the upstream client.
   */
  it('aborts the upstream request when the client disconnects after the body was read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-abort-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const signals: AbortSignal[] = []
    const shim = createWorkBuddyShim({
      store: new WorkBuddyCredentialStore({
        desktopPath: desktop,
        ownPath: join(dir, 'own.json'),
        refresh: async () => ({ accessToken: 'unused' }),
      }),
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(_credential, _bodyJson, signal): Promise<WorkBuddyChatResult> {
          if (signal !== undefined) signals.push(signal)
          // A body that never ends: the stream stays open until the client
          // disconnects, exactly the "user pressed stop" shape.
          return {
            ok: true,
            response: new Response(
              new ReadableStream<Uint8Array>({
                start() { /* never enqueue; the reader stays parked */ },
              }),
              { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            ),
          }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())

    // Raw socket: send a complete request (headers + JSON body), then hang up.
    const port = Number(new URL(shim.baseUrl()).port)
    const socket: Socket = connect(port, '127.0.0.1')
    await new Promise<void>(resolve => socket.once('connect', resolve))
    const body = JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] })
    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\n`
      + `Host: 127.0.0.1:${String(port)}\r\n`
      + `Content-Type: application/json\r\n`
      + `Authorization: Bearer ${shim.token()}\r\n`
      + `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n`
      + body,
    )
    await vi.waitFor(() => { expect(signals.length).toBe(1) }, { timeout: 5000 })
    const signal = signals[0]!
    expect(signal.aborted).toBe(false)
    socket.destroy()
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) }, { timeout: 5000 })
  })

  it('does not abort a completed stream when its response closes normally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-ok-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const signals: AbortSignal[] = []
    const shim = createWorkBuddyShim({
      store: new WorkBuddyCredentialStore({
        desktopPath: desktop,
        ownPath: join(dir, 'own.json'),
        refresh: async () => ({ accessToken: 'unused' }),
      }),
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(_c, _b, signal): Promise<WorkBuddyChatResult> {
          if (signal !== undefined) signals.push(signal)
          return {
            ok: true,
            response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
          }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    // A completed response closing normally must not read as a cancel.
    expect(signals[0]!.aborted).toBe(false)
  })

  it('answers 502 for a 200 upstream with no body instead of an empty stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-nobody-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const shim = createWorkBuddyShim({
      store: new WorkBuddyCredentialStore({
        desktopPath: desktop,
        ownPath: join(dir, 'own.json'),
        refresh: async () => ({ accessToken: 'unused' }),
      }),
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(): Promise<WorkBuddyChatResult> {
          // `new Response(null)`: a 200 whose body is literally null — the
          // shape that previously fell into the catch's bare res.end() and
          // produced a fake "complete" empty stream.
          return { ok: true, response: new Response(null, { status: 200 }) }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(response.status).toBe(502)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('server')
  })

  it('detects [DONE] split across chunks and does not append a fake one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-split-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\ndata: [DO'))
        controller.enqueue(encoder.encode('NE]\n\n'))
        controller.close()
      },
    })
    const shim = createWorkBuddyShim({
      store: new WorkBuddyCredentialStore({
        desktopPath: desktop,
        ownPath: join(dir, 'own.json'),
        refresh: async () => ({ accessToken: 'unused' }),
      }),
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(): Promise<WorkBuddyChatResult> {
          return { ok: true, response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    const text = await response.text()
    // Exactly one [DONE] — the marker that really arrived, not a duplicate
    // appended by the error path because the split marker was missed.
    expect(text.match(/\[DONE\]/gu)).toHaveLength(1)
  })

  it('ends a broken stream with an in-stream error, never a fake [DONE]', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-broken-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par'))
        controller.error(new Error('connection reset'))
      },
    })
    const shim = createWorkBuddyShim({
      store: new WorkBuddyCredentialStore({
        desktopPath: desktop,
        ownPath: join(dir, 'own.json'),
        refresh: async () => ({ accessToken: 'unused' }),
      }),
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(): Promise<WorkBuddyChatResult> {
          return { ok: true, response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    const text = await response.text()
    expect(text).not.toContain('[DONE]')
    expect(text).toContain('upstream_stream_error')
  })
})

describe('error text policy against the host AUTH heuristic (PR #58)', () => {
  /**
   * The host adapter (dsh-llm-pi-ai's classifyPiAiError) treats any error
   * text matching /\b(?:401|403)\b/ as an auth failure and the UI replaces
   * the message with an invalid-API-key banner. This pin mirrors that regex
   * so the texts this shim emits stay compatible with it: business errors
   * must not match, session failures must. If the host ever changes its
   * heuristic, update this mirror with it.
   */
  const HOST_AUTH_HEURISTIC = /\b(?:401|403)\b/u

  async function shimErrorBody(upstream: () => WorkBuddyChatResult): Promise<string> {
    const harness = await startShim(upstream)
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [] }),
    })
    expect(response.ok).toBe(false)
    return await response.text()
  }

  it('shows the display message of a review rejection without a bare 403', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 403,
      kind: 'client',
      message: JSON.stringify({
        code: 11140,
        msg: 'request illegal',
        displayMsg: { zh: '内容未通过安全审核，请调整后重试。', en: 'The content did not pass the safety review.' },
      }),
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client: 内容未通过安全审核，请调整后重试。')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(false)
  })

  it('falls back to msg and keeps the status note for non-401/403 statuses', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 400,
      kind: 'client',
      message: JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client (http 400): Illegal API invocation from an unapproved channel')
  })

  it('keeps the 401 note for a marked dead session', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: 'Offline user session not found',
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toContain('(http 401)')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(true)
  })

  it('keeps the 401 note for a markerless 401, which classifies as session_dead', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 401,
      kind: 'session_dead',
      message: 'unauthorized in some novel wording',
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream session_dead (http 401): unauthorized in some novel wording')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(true)
  })

  it('keeps an extracted display text that itself names 403, accepting the residue', async () => {
    // Known residue, pinned on purpose: when the upstream display text
    // itself contains the number ("HTTP 403: 受限"), the real text wins over
    // hiding the digits, and the host heuristic will still read it as AUTH.
    // Rewriting the digits would destroy genuine information; the fix for
    // this class belongs in the host's classifier, not here.
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 403,
      kind: 'client',
      message: JSON.stringify({ code: 11140, msg: 'request illegal', displayMsg: { zh: 'HTTP 403：访问受限，请稍后重试' } }),
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client: HTTP 403：访问受限，请稍后重试')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(true)
  })

  it('hides the bare 403 from a markerless 403 business error even in raw fallback', async () => {
    const text = await shimErrorBody(() => ({
      ok: false,
      status: 403,
      kind: 'client',
      message: 'plain text refusal without json',
    }))
    const body = JSON.parse(text) as { error: { message: string } }
    expect(body.error.message).toBe('workbuddy upstream client: plain text refusal without json')
    expect(HOST_AUTH_HEURISTIC.test(body.error.message)).toBe(false)
  })
})
