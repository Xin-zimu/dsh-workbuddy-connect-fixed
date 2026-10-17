import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  WINDOWS_REGISTRY_STEP_TIMEOUT_MS,
  WORKBUDDY_DISCOVERY_BUDGET_MS,
  WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS,
  workBuddyWindowsDiscoveryTools,
} from '../src/desktop-credential-protection.ts'

type RegistryFailure = Error & { code: number | string, killed?: boolean }

function registryFailure(stderr: string | Buffer, killed = false): void {
  execFileMock.mockImplementation((
    _binary: string,
    _args: string[],
    _options: object,
    callback: (error: RegistryFailure, stdout: Buffer, stderr: Buffer) => void,
  ) => {
    const child = new EventEmitter()
    const error = Object.assign(new Error('reg query failed'), { code: 1, killed })
    const stderrBytes = typeof stderr === 'string' ? Buffer.from(stderr, 'utf8') : stderr
    queueMicrotask(() => {
      // Bytes pass through untouched; a string is UTF-8 encoded, which is what
      // a caller writing a literal expects. The production path hands over raw
      // bytes (`encoding: 'buffer'`), so a test that cares about the code page
      // must pass the Buffer itself.
      callback(error, Buffer.alloc(0), stderrBytes)
      child.emit('close')
    })
    return child
  })
}

/**
 * Answer each invocation by binary path: `reg.exe` gets `regBytes`, the
 * fallback interpreter gets `fallback`, so the two paths can be scripted
 * independently. Both receive Buffers, as `encoding: 'buffer'` delivers.
 */
function registryStdout(
  regBytes: Buffer,
  options: {
    fallback?: { stdout?: string, code?: number | string, fail?: boolean, killed?: boolean }
    onSpawn?: (binary: string, args: string[], execOptions: object) => void
  } = {},
): void {
  execFileMock.mockImplementation((
    binary: string,
    args: string[],
    execOptions: object,
    callback: (error: RegistryFailure | null, stdout: Buffer, stderr: Buffer) => void,
  ) => {
    const child = new EventEmitter()
    options.onSpawn?.(binary, args, execOptions)
    const isFallback = /powershell/iu.test(binary)
    queueMicrotask(() => {
      if (!isFallback) {
        callback(null, regBytes, Buffer.alloc(0))
      } else if (options.fallback?.fail === true) {
        const error = Object.assign(new Error('powershell failed'), {
          code: options.fallback.code ?? 1,
          killed: options.fallback.killed ?? false,
        })
        callback(error, Buffer.alloc(0), Buffer.from('error', 'utf8'))
      } else {
        callback(null, Buffer.from(options.fallback?.stdout ?? '[]', 'utf8'), Buffer.alloc(0))
      }
      child.emit('close')
    })
    return child
  })
}

/** GBK bytes for 人工智能, which is what a zh-CN console emits for that path. */
const GBK_CJK = Buffer.from([0xc8, 0xcb, 0xb9, 0xa4, 0xd6, 0xc7, 0xc4, 0xdc])

afterEach(() => {
  vi.unstubAllEnvs()
  execFileMock.mockReset()
})

describe('Windows registry query failure classification', () => {
  it.each([
    'ERROR: The system was unable to find the specified registry key or value.',
    '错误: 系统找不到指定的注册表项或值。',
  ])('treats a confirmed missing key as an empty result: %s', async stderr => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(stderr)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Missing', new AbortController().signal))
      .resolves.toBe('')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  /**
   * The bytes a real zh-CN host actually emits, measured through the
   * production spawn shape.
   *
   * These are the raw stderr bytes of
   * `reg query <missing> /s` started with `windowsHide: true` on a zh-CN
   * Windows 11 26100 host: the message is written in the GBK/OEM code page
   * (「错误: 系统找不到指定的注册表项或值。」 plus CRLF), *not* UTF-8. The
   * regression this pins: the decoder used to be fixed at UTF-8, so these
   * bytes became replacement characters, the Chinese pattern could never
   * match, and a **missing** root was reported as
   * `DiscoveryIncompleteError` — "we could not check" — on every zh-CN
   * machine. `discoverWindowsApp` turns that into `unresolved`, and the whole
   * Windows app discovery degrades to `electron-binary-unavailable`.
   *
   * The bytes are spelled out rather than produced by `Buffer.from(text,
   * 'gbk')`, because Node has no GBK *encoder* — only the decoder — so a
   * literal is the only way to state the real input. Upstream reached the same
   * fix independently and contributed the second entry: the same message with
   * the **fullwidth** colon, which cp936 also produces. Both are real host
   * output, so both are pinned.
   */
  const GBK_KEY_MISSING = Buffer.from(
    'b4edcef33a20cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4d7a2b2e1b1edcfeebbf2d6b5a1a30d0a',
    'hex',
  )
  /** The same diagnostic with `：` (U+FF1A) instead of the ASCII colon. */
  const GBK_KEY_MISSING_FULLWIDTH = Buffer.from(
    'b4edcef3a3bacfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4d7a2b2e1b1edcfeebbf2d6b5a1a3',
    'hex',
  )

  it.each([
    ['ASCII colon', GBK_KEY_MISSING],
    ['fullwidth colon', GBK_KEY_MISSING_FULLWIDTH],
  ])('treats the GBK missing-key diagnostic as an empty result (zh-CN host, windowsHide, %s)', async (_label, bytes) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(bytes)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Missing', new AbortController().signal))
      .resolves.toBe('')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ASCII colon', GBK_KEY_MISSING],
    ['fullwidth colon', GBK_KEY_MISSING_FULLWIDTH],
  ])('confirms the %s fixture really is GBK and really is not UTF-8', (_label, bytes) => {
    // Guards the guard: if either fixture ever became valid UTF-8 (or stopped
    // decoding as GBK), the case above would still pass for the wrong reason
    // and prove nothing about the code page.
    expect(bytes.every(byte => byte < 0x80), 'the fixture must carry non-ASCII bytes').toBe(false)
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
    // Both decode to the diagnostic, differing only in the colon glyph.
    expect(new TextDecoder('gbk').decode(bytes).trim()).toMatch(/^错误[:：]\s*系统找不到指定的注册表项或值。$/u)
  })

  it('does not accept the GBK diagnostic when it is not the whole message', async () => {
    // The patterns are anchored, so a localized diagnostic embedded in other
    // output is not a confirmed missing key. Appending a line models a child
    // that failed for a reason beyond the missing root.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(Buffer.concat([GBK_KEY_MISSING, Buffer.from('ERROR: Access is denied.\r\n', 'utf8')]))
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
  })

  it.each([
    ['access denied', 'ERROR: Access is denied.', false],
    ['unknown diagnostic', 'ERROR: registry query failed.', false],
    ['killed query', 'ERROR: The system was unable to find the specified registry key or value.', true],
  ])('keeps %s incomplete even when reg.exe returns code 1', async (_label, stderr, killed) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure(stderr, killed)
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
  })

  it('keeps an oversized document incomplete and names the size limit, not a timeout', async () => {
    // Node delivers a maxBuffer overflow as code ERR_CHILD_PROCESS_STDIO_MAXBUFFER
    // with `killed` unset (verified against a real child on this codebase's Node
    // range): a software-dense machine whose uninstall tree exceeds the 1 MiB
    // cap must stay "we could not check", never "not installed", and the
    // message must not point the user at scheduler latency.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    execFileMock.mockImplementation((
      _binary: string,
      _args: string[],
      _options: object,
      callback: (error: RegistryFailure, stdout: Buffer, stderr: Buffer) => void,
    ) => {
      const child = new EventEmitter()
      const error = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      queueMicrotask(() => {
        callback(error, Buffer.alloc(0), Buffer.alloc(0))
        child.emit('close')
      })
      return child
    })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/reg\.exe could not complete \(the output exceeded the size limit\)/)
  })
})

describe('issue #88: fallback triggers on ambiguous bytes only', () => {
  const ASCII_DOCUMENT = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST-0}',
    '    DisplayName    REG_SZ    WorkBuddy',
    '    DisplayIcon    REG_SZ    "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",0',
  ].join('\r\n')

  it('does not consult the fallback for ASCII-only output', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const spawned: string[] = []
    registryStdout(Buffer.from(ASCII_DOCUMENT, 'ascii'), { onSpawn: binary => { spawned.push(binary) } })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe')
    // Exactly one process: no fallback on the overwhelmingly common path.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatch(/reg\.exe$/u)
  })

  it('consults the fallback when a byte outside ASCII appears', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const spawned: string[] = []
    // GBK bytes: the code page is unknowable from the bytes, so the primary
    // reading is not trusted and the root is re-read through Unicode.
    const ambiguous = Buffer.concat([
      Buffer.from(ASCII_DOCUMENT.replace('C:\\Program Files', 'F:\\').split('F:\\')[0]!, 'ascii'),
      GBK_CJK,
      Buffer.from('\\WorkBuddy\\WorkBuddy.exe",0', 'ascii'),
    ])
    registryStdout(ambiguous, {
      fallback: {
        stdout: JSON.stringify([
          { displayName: 'WorkBuddy', displayIcon: 'F:\\人工智能\\WorkBuddy\\WorkBuddy.exe' },
        ]),
      },
      onSpawn: binary => { spawned.push(binary) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('F:\\人工智能\\WorkBuddy\\WorkBuddy.exe')
    expect(output).not.toContain('\uFFFD')
    expect(spawned.some(binary => /powershell/iu.test(binary))).toBe(true)
  })

  it('triggers on any non-ASCII byte, including pairs that decode cleanly', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    // 0xC3 0xA9 is the reviewer's counterexample: valid UTF-8 ("é") AND valid
    // GBK ("茅"). A U+FFFD-based trigger would miss it entirely; the byte-range
    // trigger cannot.
    const bytes = Buffer.from([0xc3, 0xa9])
    expect(bytes.toString('utf8')).not.toContain('\uFFFD')
    const spawned: string[] = []
    registryStdout(Buffer.concat([Buffer.from('x', 'ascii'), bytes]), {
      fallback: { stdout: '[]' },
      onSpawn: binary => { spawned.push(binary) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toBe('')
    expect(spawned.some(binary => /powershell/iu.test(binary))).toBe(true)
  })

  it('re-reads the whole root when the non-ASCII bytes belong to unrelated software (deliberate over-trigger)', async () => {
    // The recorded follow-up cost of #105/#106/#107: the trigger is a
    // property of the *root's* bytes, so another product's localized
    // DisplayName re-reads the root too. Narrowing the trigger to this
    // product's own entries would mean associating value lines with key
    // headers before the bytes can be decoded, and the WorkBuddy entry's own
    // bytes may be the non-ASCII ones — a wrong association silently drops a
    // real Chinese install path back into the code-page trap #88 fixed. The
    // whole-root granularity of the Unicode fallback (#88) is deliberate:
    // narrowing the re-read to individual subkeys would require passing
    // subkey paths across the process boundary, and a subkey path's own
    // bytes can be the ambiguous ones — decoding them is the code-page guess
    // #88 forbids. The -Root bound PowerShell query (#106) therefore
    // receives only the provably-ASCII root and enumerates everything under
    // it itself. This test pins that granularity: exactly one whole-root
    // re-read, whose authoritative output carries the ASCII WorkBuddy entry
    // unchanged.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const unrelated = Buffer.concat([
      Buffer.from('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OTHER-0}\r\n    DisplayName    REG_SZ    ', 'ascii'),
      GBK_CJK,
      Buffer.from('\r\n', 'ascii'),
    ])
    const workbuddyAscii = Buffer.from([
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST-0}',
      '    DisplayName    REG_SZ    WorkBuddy',
      '    DisplayIcon    REG_SZ    "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",0',
    ].join('\r\n'), 'ascii')
    const spawned: string[] = []
    registryStdout(Buffer.concat([unrelated, workbuddyAscii]), {
      fallback: {
        stdout: JSON.stringify([
          { displayName: '别的软件', displayIcon: 'F:\\人工智能\\Other\\Other.exe' },
          { displayName: 'WorkBuddy', displayIcon: 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe' },
        ]),
      },
      onSpawn: binary => { spawned.push(binary) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    // One re-read covering the whole root, and the ASCII WorkBuddy entry
    // survives it intact rather than being mixed from two sources.
    expect(spawned.filter(binary => /powershell/iu.test(binary))).toHaveLength(1)
    expect(output).toContain('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe')
    expect(output).toContain('别的软件')
    expect(output.includes('{PS-'), 'the document must be the fallback re-encoding, not raw reg.exe text').toBe(true)
    expect(output.includes('{OTHER-0}'), 'raw reg.exe key headers must not leak through').toBe(false)
  })

  it('does not call the fallback when reg.exe already failed', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryFailure('ERROR: Access is denied.')
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKLM\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('routes the root as an argument, never into the command text', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), {
      fallback: { stdout: '[]' },
      onSpawn: (binary, args) => { calls.push({ binary, args }) },
    })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Software\\Uninstall', new AbortController().signal)
    const fallbackCall = calls.find(call => /powershell/iu.test(call.binary))!
    const commandIndex = fallbackCall.args.indexOf('-Command')
    expect(fallbackCall.args[commandIndex + 1]).not.toContain('HKCU')
    expect(fallbackCall.args[fallbackCall.args.indexOf('-Root') + 1]).toBe('HKCU\\Software\\Uninstall')
  })

  it('declares param first and sets the output encoding after it', async () => {
    // Review flagged the ordering: a `param` block must lead the script block,
    // so the encoding assignment cannot precede it. Asserted on the command
    // actually handed to the child, which is the real artifact.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    const script = call.args[call.args.indexOf('-Command') + 1]!
    expect(script).toContain('param([string]$Root)')
    expect(script.indexOf('param([string]$Root)')).toBeLessThan(script.indexOf('[Console]::OutputEncoding'))
  })

  it('wraps the script in a scriptblock so the separate -Root argv binds', async () => {
    // Regression for the reviewed defect: powershell.exe treats everything
    // after `-Command` as the command string plus arguments *to that string*,
    // so a bare `param([string]$Root)` script leaves `$Root` empty when the
    // value arrives as its own argv element — the script then queried
    // `Registry::` and exited 3 on every machine that needed the #88 fallback.
    // The `& { … }` wrapper is what binds the trailing arguments.
    // `tests/windows-powershell-binding.spec.ts` proves this against a real
    // powershell.exe; this pins the shape the production call must keep.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    const commandIndex = call.args.indexOf('-Command')
    const script = call.args[commandIndex + 1]!
    expect(script.startsWith('& { ')).toBe(true)
    expect(script.endsWith(' }')).toBe(true)
    // The root still travels as its own argv element, never in the command text.
    expect(call.args[commandIndex + 2]).toBe('-Root')
    expect(call.args[commandIndex + 3]).toBe('HKCU\\Uninstall')
    expect(script).not.toContain('HKCU')
  })
})

describe('issue #88: fallback failure classification', () => {
  const AMBIGUOUS = Buffer.concat([GBK_CJK])

  it('treats an absent root as an empty result, not a failure', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 2 } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Missing', new AbortController().signal))
      .resolves.toBe('')
  })

  it('keeps an unreadable root incomplete rather than empty', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    // An unopenable subkey could have been a real candidate, so this must not
    // become "no app installed".
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 3 } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not read the registry root/)
  })

  it('keeps other failures incomplete', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 1 } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/could not complete/)
  })

  it('reports a timeout as incomplete', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, killed: true } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/timed out/)
  })

  it('keeps an oversized fallback document incomplete and names the size limit', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { fail: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/powershell\.exe could not complete \(the output exceeded the size limit\)/)
  })

  it('rejects an unrecognised document rather than guessing at it', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, { fallback: { stdout: 'not json' } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal))
      .rejects.toThrow(/not the expected registry document/)
  })

  it('accepts a single record, since ConvertTo-Json drops the array wrapper', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, {
      fallback: { stdout: JSON.stringify({ displayName: 'WorkBuddy', displayIcon: 'F:\\人工智能\\WorkBuddy\\WorkBuddy.exe' }) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('DisplayIcon')
    expect(output).toContain('F:\\人工智能\\WorkBuddy\\WorkBuddy.exe')
  })

  it('skips records carrying neither value', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    registryStdout(AMBIGUOUS, {
      fallback: { stdout: JSON.stringify([{ other: 1 }, { displayName: 'WorkBuddy' }]) },
    })
    const output = await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    expect(output).toContain('DisplayName')
    expect(output).not.toContain('other')
  })

  it('uses PowerShell 5.1-compatible invocation flags', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(AMBIGUOUS, { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    expect(call.args).toContain('-NoProfile')
    expect(call.args).toContain('-NonInteractive')
    expect(call.binary).toContain('WindowsPowerShell')
  })
})

describe('issues #105/#106/#107: -Command argument binding on Windows PowerShell 5.1', () => {
  it('hands -Command a call-operator script block so the trailing -Root binds', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    const root = 'HKCU\\Uninstall'
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal)
    const call = calls.find(c => /powershell/iu.test(c.binary))!
    const commandIndex = call.args.indexOf('-Command')
    // Windows PowerShell 5.1 joins every argument after -Command into ONE
    // command string and parses that string as code; it does not bind
    // trailing `-Root <path>` tokens to a script whose text merely starts
    // with `param`. The pre-fix argv (a bare `param(...)` script with
    // `-Root <path>` after it) therefore left $Root empty — the trailing
    // tokens landed inside the script text — and every fallback query ended
    // as exit 2/3 (#105/#106/#107). These assertions are made against the
    // joined command the child actually re-parses, so the bare-`param` shape
    // fails them while the call-operator wrapper passes: `& { … }` makes the
    // operator apply `-Root <path>` to the script block's param block, the
    // form #106 verified on a real 5.1 machine.
    const commandText = call.args.slice(commandIndex + 1).join(' ')
    const suffix = ` } -Root ${root}`
    expect(commandText.startsWith('& { ')).toBe(true)
    expect(commandText.endsWith(suffix)).toBe(true)
    expect(commandText).toContain('param([string]$Root)')
    // The root rides only as the -Root value, never inside the script block
    // the call operator executes.
    expect(commandText.slice(0, commandText.length - suffix.length)).not.toContain(root)
  })

  it('keeps exactly one fallback process per root, with no shell in between', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, args: string[] }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    // The wrapper lives inside the -Command text powershell.exe itself
    // parses: no cmd.exe, no second interpreter, no extra process.
    const fallbackCalls = calls.filter(c => /powershell/iu.test(c.binary))
    expect(fallbackCalls).toHaveLength(1)
    expect(calls.filter(c => /cmd|pwsh/iu.test(c.binary))).toHaveLength(0)
  })

  it('passes the three production roots through to the fallback', async () => {
    // Positive control for the root shape guard: the fixed roots production
    // queries must all reach the fallback, so the guard can never silently
    // disable discovery.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    for (const root of [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]) {
      execFileMock.mockReset()
      const calls: { binary: string, args: string[] }[] = []
      registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: (binary, args) => { calls.push({ binary, args }) } })
      await workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal)
      const fallbackCalls = calls.filter(c => /powershell/iu.test(c.binary))
      expect(fallbackCalls).toHaveLength(1)
      expect(fallbackCalls[0]!.args[fallbackCalls[0]!.args.indexOf('-Root') + 1]).toBe(root)
    }
  })
})

describe('issues #105/#106/#107: Windows registry step budget', () => {
  it('gives reg.exe and the PowerShell fallback the Windows step limit, not the macOS one', async () => {
    // Real CI evidence behind this: on GitHub's windows-2022/2025 images the
    // plain HKLM uninstall `reg query /s` needs more than the old 3s step
    // limit, so a software-dense machine read as "absent" when it was merely
    // slow. Both Windows subprocesses must carry the Windows-specific limit.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const calls: { binary: string, options: { timeout?: number } }[] = []
    registryStdout(Buffer.concat([GBK_CJK]), {
      fallback: { stdout: '[]' },
      onSpawn: (binary, _args, execOptions) => { calls.push({ binary, options: execOptions as { timeout?: number } }) },
    })
    await workBuddyWindowsDiscoveryTools().queryUninstallRoot('HKCU\\Uninstall', new AbortController().signal)
    const reg = calls.find(call => /reg\.exe$/u.test(call.binary))
    const fallback = calls.find(call => /powershell/iu.test(call.binary))
    expect(reg?.options.timeout).toBe(WINDOWS_REGISTRY_STEP_TIMEOUT_MS)
    expect(fallback?.options.timeout).toBe(WINDOWS_REGISTRY_STEP_TIMEOUT_MS)
    expect(WINDOWS_REGISTRY_STEP_TIMEOUT_MS).not.toBe(WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS)
  })

  it('keeps a Windows step within the whole-discovery budget', () => {
    // The budget, not the step limit, stays the user-facing ceiling: a step
    // may never outlive the whole discovery, so raising the Windows step
    // limit cannot raise the worst-case wait. The budget itself is pinned so
    // that changing it is a deliberate decision, never a side effect.
    expect(WINDOWS_REGISTRY_STEP_TIMEOUT_MS).toBeLessThanOrEqual(WORKBUDDY_DISCOVERY_BUDGET_MS)
    expect(WORKBUDDY_DISCOVERY_BUDGET_MS).toBe(10_000)
    expect(WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS).toBe(3_000)
  })
})

describe('issues #105/#106/#107: roots are guarded before they reach a command line', () => {
  // `powershell.exe` re-parses everything after -Command as code, so a root
  // is only allowed onto that command line when it is provably inert in that
  // position. Each case below is executable text, a token splitter, or not a
  // registry path at all; all must be refused before any process starts.
  it.each([
    ['statement separator', 'HKCU\\Software; Remove-Item -Recurse C:\\'],
    ['subexpression', 'HKCU\\Software$(Remove-Item -Recurse C:\\)'],
    ['backtick escape', 'HKCU\\Software`Remove-Item'],
    ['double quote', 'HKCU\\Software"'],
    ['single quote', "HKCU\\Software'"],
    ['space splitting a component', 'HKCU\\Software\\Program Files\\Uninstall'],
    ['brace block', 'HKCU\\Software\\{GUID}'],
    ['ampersand chaining', 'HKLM\\Software & whoami'],
    ['not a hive', 'HKXX\\Software'],
    ['hive without a subkey', 'HKLM'],
  ])('refuses %s without starting the fallback', async (_label, root) => {
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const spawned: string[] = []
    registryStdout(Buffer.concat([GBK_CJK]), { fallback: { stdout: '[]' }, onSpawn: binary => { spawned.push(binary) } })
    await expect(workBuddyWindowsDiscoveryTools().queryUninstallRoot(root, new AbortController().signal))
      .rejects.toThrow(/plain HKLM\/HKCU path this tool may query/)
    // reg.exe already ran (its output was ambiguous); the fallback must not.
    expect(spawned.filter(binary => /powershell/iu.test(binary))).toHaveLength(0)
  })
})
