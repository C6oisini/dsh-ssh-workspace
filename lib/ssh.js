// SSH transport for the remote-workspace plugin.
//
// Design constraints (agreed with the user):
//   • zero install on the remote host — only the system `ssh` client and
//     POSIX shell tools are used;
//   • credentials come from ~/.ssh/config, the ssh-agent and IdentityFile
//     entries; this plugin never stores or reads a private key itself;
//   • one multiplexed connection per host (ControlMaster), so a session that
//     runs many tool calls pays the handshake once.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const SSH_ROOT = path.join(DSH_HOME, 'ssh-workspace')
const CONTROL_DIR = path.join(SSH_ROOT, 'cm')
const MAX_CAPTURE = 8 * 1024 * 1024

/** Single-quote a string for embedding in a POSIX shell script. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function readConfigFile(file, seen, hosts) {
  if (seen.has(file)) return
  seen.add(file)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      current = { alias: value, hostname: '', user: '', port: 0 }
      hosts.push(current)
      continue
    }
    if (key === 'include') {
      for (const pattern of value.split(/\s+/)) {
        const expanded = pattern.startsWith('~/')
          ? path.join(os.homedir(), pattern.slice(2))
          : path.isAbsolute(pattern) ? pattern : path.join(path.dirname(file), pattern)
        // Globs are rare in practice; only handle the literal file case.
        if (!/[*?]/.test(expanded)) readConfigFile(expanded, seen, hosts)
      }
      continue
    }
    if (!current) continue
    if (key === 'hostname') current.hostname = value.split(/\s+/)[0]
    else if (key === 'user') current.user = value.split(/\s+/)[0]
    else if (key === 'port') current.port = Number(value.split(/\s+/)[0]) || 0
  }
}

/**
 * Hosts declared in ~/.ssh/config (Include files followed one level deep).
 * Wildcard entries and `!negations` are dropped: they are patterns, not
 * connectable destinations. Entries without a HostName connect to their alias.
 */
export function sshHosts(configPath = path.join(os.homedir(), '.ssh', 'config')) {
  const hosts = []
  readConfigFile(configPath, new Set(), hosts)
  const seen = new Set()
  const result = []
  for (const host of hosts) {
    for (const alias of host.alias.split(/\s+/)) {
      if (!alias || /[*?!]/.test(alias) || alias.includes('%')) continue
      if (seen.has(alias)) continue
      seen.add(alias)
      result.push({
        alias,
        hostname: host.hostname || alias,
        user: host.user || '',
        port: host.port || 22,
      })
    }
  }
  result.sort((a, b) => a.alias.localeCompare(b.alias))
  return result
}

/** Spawn one ssh invocation; exposes stdout/stderr capped at 8MB each. */
function spawnSsh(alias, script, timeoutMs) {
  return new Promise((resolve) => {
    fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 })
    const args = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', `ControlPath=${CONTROL_DIR}/%C`,
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=300',
      alias,
      'bash', '-l', '-s',
    ]
    let child
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String((error && error.message) || error), timedOut: false })
      return
    }
    const chunks = { out: [], err: [], outSize: 0, errSize: 0 }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', (chunk) => {
      chunks.outSize += chunk.length
      if (chunks.outSize <= MAX_CAPTURE) chunks.out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      chunks.errSize += chunk.length
      if (chunks.errSize <= MAX_CAPTURE) chunks.err.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: String((error && error.message) || error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code === null ? -1 : code,
        stdout: Buffer.concat(chunks.out).toString('utf8'),
        stderr: Buffer.concat(chunks.err).toString('utf8'),
        timedOut,
      })
    })
    // The script rides stdin: no quoting layer can mangle it, and stdin also
    // keeps `bash -s` non-interactive.
    child.stdin.end(script)
  })
}

function describeFailure(alias, result) {
  const stderr = result.stderr.trim()
  const suffix = stderr ? `: ${stderr}` : ''
  if (result.timedOut) return `SSH ${alias}: command timed out`
  if (result.code === 255) {
    return `SSH ${alias}: connection failed${suffix}. Check ~/.ssh/config, the host key and the key/agent for this host.`
  }
  return `SSH ${alias}: command failed (exit ${result.code})${suffix}`
}

// Connection failures that happen before the remote shell starts are safe to
// retry once: the command has not run yet. Errors that can appear mid-script
// (Broken pipe, Connection reset) are deliberately not retried, since a
// side-effecting command may already have executed.
const TRANSIENT_CONNECT = /(Connection refused|Connection timed out|No route to host|Network is unreachable|kex_exchange_identification|Connection closed by remote host)/i

function failure(alias, result) {
  const error = new Error(describeFailure(alias, result))
  error.code = result.code
  error.stdout = result.stdout
  error.stderr = result.stderr
  error.timedOut = result.timedOut
  return error
}

/** Run a shell script on the host; throws with a readable diagnostic. */
export async function execRemote(alias, script, { timeoutMs = 120000 } = {}) {
  let result = await spawnSsh(alias, script, timeoutMs)
  if (result.code !== 0 && !result.timedOut && TRANSIENT_CONNECT.test(result.stderr)) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    result = await spawnSsh(alias, script, timeoutMs)
  }
  if (result.code !== 0) throw failure(alias, result)
  return result
}

export async function pingHost(alias) {
  try {
    await execRemote(alias, 'true\n', { timeoutMs: 15000 })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** Resolve a tool path against the workspace root; absolute stays absolute. */
export function resolveRemotePath(root, raw) {
  const value = String(raw == null ? '' : raw).trim()
  if (!value) return root
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value)
  return path.posix.join(root, value)
}

function decodeBase64(text) {
  const compact = text.replace(/\s+/g, '')
  return Buffer.from(compact, 'base64').toString('utf8')
}

/**
 * Read a remote text file. Returns { text, size, truncated }.
 * Binary content (NUL byte in the first 8KB) is rejected instead of being
 * rendered as mojibake.
 */
export async function readRemoteFile(alias, remotePath, { maxBytes = 512 * 1024 } = {}) {
  const script = [
    `p=${shq(remotePath)}`,
    'if [ -d "$p" ]; then echo "@@DIRECTORY"; exit 0; fi',
    'if [ ! -e "$p" ]; then echo "@@MISSING"; exit 0; fi',
    'sz=$(wc -c < "$p")',
    'echo "@@SIZE $sz"',
    'if [ "$sz" -gt 67108864 ]; then echo "@@TOO_LARGE"; exit 0; fi',
    `head -c ${maxBytes} -- "$p" | base64`,
    '',
  ].join('\n')
  const { stdout } = await execRemote(alias, script, { timeoutMs: 60000 })
  if (stdout.startsWith('@@MISSING')) throw new Error(`read: remote file not found: ${remotePath}`)
  if (stdout.startsWith('@@DIRECTORY')) throw new Error(`read: ${remotePath} is a directory (use ssh_ls)`)
  if (stdout.startsWith('@@TOO_LARGE')) throw new Error(`read: ${remotePath} is larger than 64MB`)
  const newline = stdout.indexOf('\n')
  if (newline < 0) throw new Error(`read: unexpected response for ${remotePath}`)
  const size = Number(stdout.slice(0, newline).replace('@@SIZE ', '')) || 0
  const buffer = Buffer.from(stdout.slice(newline + 1).replace(/\s+/g, ''), 'base64')
  const head = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (head.includes(0)) throw new Error(`read: ${remotePath} looks binary (contains NUL bytes)`)
  if (size > maxBytes) {
    const text = buffer.subarray(0, maxBytes).toString('utf8')
    return { text, size, truncated: true }
  }
  return { text: buffer.toString('utf8'), size, truncated: false }
}

/** Write UTF-8 text through a remote heredoc (no argv length limit). */
export async function writeRemoteFile(alias, remotePath, text) {
  const encoded = Buffer.from(String(text), 'utf8').toString('base64')
  const lineWidth = 76
  const lines = []
  for (let index = 0; index < encoded.length; index += lineWidth) {
    lines.push(encoded.slice(index, index + lineWidth))
  }
  const delimiter = `DSH_SSH_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const script = [
    'set -e',
    `p=${shq(remotePath)}`,
    // Editing through a symlink should update its target, not replace the link
    // with a regular file.
    'if [ -L "$p" ]; then t=$(readlink -f -- "$p" 2>/dev/null || true); if [ -n "$t" ]; then p="$t"; fi; fi',
    'mkdir -p -- "$(dirname -- "$p")"',
    'tmp="$p.dsh-tmp.$$"',
    "trap 'rm -f -- \"$tmp\"' EXIT",
    `base64 -d > "$tmp" <<'${delimiter}'`,
    ...lines,
    delimiter,
    // `mv` replaces the inode, so copy the old permission bits first; new
    // files keep the default umask (no chmod attempts).
    'if [ -e "$p" ]; then',
    '  chmod --reference="$p" "$tmp" 2>/dev/null || chmod "$(stat -c %a -- "$p" 2>/dev/null || echo 644)" "$tmp" 2>/dev/null || true',
    'fi',
    'mv -f -- "$tmp" "$p"',
    'trap - EXIT',
    '',
  ].join('\n')
  await execRemote(alias, script, { timeoutMs: 60000 })
  return { bytes: Buffer.byteLength(String(text), 'utf8') }
}

export async function statRemotePath(alias, remotePath) {
  const script = [
    `p=${shq(remotePath)}`,
    'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "@@MISSING"; exit 0; fi',
    `stat -c '%F\t%s\t%Y\t%A\t%N' -- "$p" 2>/dev/null || ls -ld -- "$p"`,
    '',
  ].join('\n')
  const { stdout } = await execRemote(alias, script, { timeoutMs: 30000 })
  if (stdout.startsWith('@@MISSING')) return { exists: false, path: remotePath }
  const line = stdout.split('\n')[0]
  const [kind, size, mtime, mode, ...rest] = line.split('\t')
  return {
    exists: true,
    path: remotePath,
    kind: kind || '',
    size: Number(size) || 0,
    mtime: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : '',
    mode: mode || '',
    detail: rest.join('\t'),
  }
}

/** List one directory: entries carry name/type/size/mtime. */
export async function listRemoteDir(alias, remotePath) {
  // A null path means "the login home directory": the panel opens there before
  // the user has navigated anywhere.
  const script = [
    `p=${remotePath == null ? '"$HOME"' : shq(remotePath)}`,
    // The browse bar accepts ~ / ~/sub as well as absolute paths.
    'case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/${p#"~/"}";; esac',
    'if [ ! -d "$p" ]; then echo "@@NOT_DIRECTORY"; exit 0; fi',
    'echo "@@PATH $(cd -- "$p" && pwd -P)"',
    `find "$p" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | head -n 3000`,
    '',
  ].join('\n')
  const { stdout } = await execRemote(alias, script, { timeoutMs: 30000 })
  if (stdout.startsWith('@@NOT_DIRECTORY')) throw new Error(`ls: not a directory: ${remotePath || '~'}`)
  let resolvedPath = remotePath || '~'
  const pathLine = /^@@PATH (.+)$/m.exec(stdout)
  if (pathLine) resolvedPath = pathLine[1]
  const entries = []
  for (const line of stdout.split('\n')) {
    if (!line || line.startsWith('@@PATH ')) continue
    const [type, size, mtime, name] = line.split('\t')
    if (!name) continue
    entries.push({
      name,
      type: type === 'd' ? 'directory' : type === 'f' ? 'file' : type === 'l' ? 'symlink' : 'other',
      size: Number(size) || 0,
      mtime: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : '',
    })
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
  return { path: resolvedPath, entries }
}

export async function globRemote(alias, root, pattern, { limit = 300 } = {}) {
  const script = [
    'shopt -s globstar nullglob dotglob',
    `cd -- ${shq(root)} || exit 2`,
    `matches=( ${pattern} )`,
    'count=0',
    'for m in "${matches[@]}"; do',
    '  printf "%s\\t%s\\n" "$m" "$(stat -c %F -- "$m" 2>/dev/null)"',
    '  count=$((count+1))',
    `  if [ "$count" -ge ${limit} ]; then break; fi`,
    'done',
    '',
  ].join('\n')
  const { stdout } = await execRemote(alias, script, { timeoutMs: 60000 })
  const entries = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [name, kind] = line.split('\t')
    if (!name) continue
    entries.push({ path: name, kind: kind || '' })
  }
  return entries
}

export async function grepRemote(alias, root, { pattern, path: rawPath, glob, limit = 200 }) {
  const target = shq(rawPath || '.')
  const ripgrep = [
    'if command -v rg >/dev/null 2>&1; then',
    `  rg -n --no-heading --color never -S ${glob ? `--glob ${shq(glob)} ` : ''}-e ${shq(pattern)} -- ${target} | head -n ${limit}`,
    'else',
    `  grep -rn -I --exclude-dir=.git -E -e ${shq(pattern)} -- ${target} | head -n ${limit}`,
    'fi',
    '',
  ].join('\n')
  const script = [`cd -- ${shq(root)} || exit 2`, ripgrep].join('\n')
  const { stdout } = await execRemote(alias, script, { timeoutMs: 120000 })
  return stdout.split('\n').filter(Boolean).map((line) => {
    const match = /^(.+?):(\d+):(.*)$/.exec(line)
    return match ? { path: match[1], line: Number(match[2]), text: match[3] } : { text: line }
  })
}

export async function runRemoteCommand(alias, root, command, { timeoutMs = 120000 } = {}) {
  const script = [
    `cd -- ${shq(root)} || { echo "cannot cd to ${String(root).replace(/"/g, '')}" >&2; exit 2; }`,
    'set -o pipefail 2>/dev/null || true',
    command,
    '',
  ].join('\n')
  try {
    const result = await execRemote(alias, script, { timeoutMs })
    return { code: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : -1,
      stdout: error.stdout || '',
      stderr: error.stderr || String((error && error.message) || error),
      timedOut: Boolean(error.timedOut),
    }
  }
}

const instructionCache = new Map()

/**
 * Read AGENTS.md / CLAUDE.md at the remote workspace root. The result is
 * cached per binding for 5 minutes so the prompt section can use it
 * synchronously after the first assembly.
 */
export function remoteInstructions(alias, remotePath) {
  const key = `${alias}\u0000${remotePath}`
  const cached = instructionCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached
  if (cached && cached.loading) return cached
  const entry = { at: 0, loading: true, files: [] }
  instructionCache.set(key, entry)
  void (async () => {
    const script = [
      `cd -- ${shq(remotePath)} 2>/dev/null || exit 0`,
      'for f in AGENTS.md CLAUDE.md; do',
      '  if [ -f "$f" ]; then',
      '    sz=$(wc -c < "$f")',
      '    if [ "$sz" -le 65536 ]; then echo "@@FILE $f"; base64 < "$f"; fi',
      '  fi',
      'done',
      '',
    ].join('\n')
    const files = []
    try {
      const { stdout } = await execRemote(alias, script, { timeoutMs: 30000 })
      const parts = stdout.split(/^@@FILE (.+)$/m)
      for (let index = 1; index < parts.length; index += 2) {
        const name = parts[index]
        const body = (parts[index + 1] || '').replace(/\s+/g, '')
        files.push({ name, text: Buffer.from(body, 'base64').toString('utf8') })
      }
    } catch {
      // Unreachable host: leave the cache empty and retry after the TTL.
    }
    entry.files = files
    entry.loading = false
    entry.at = Date.now()
  })()
  return entry
}
