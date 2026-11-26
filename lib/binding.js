// Sentinel-directory bindings.
//
// A remote workspace is represented by an EMPTY local directory under
// $DSH_HOME/ssh-workspace/workspaces/<host>/<name>-<hash>/ whose cwd becomes
// the session cwd. Nothing is mirrored: the folder exists so the native
// session/workspace machinery (titles, resume, lists) has a real local path,
// and the `.dsh-ssh.json` inside it is the single source of truth that lets
// the host plugin recover the binding after a restart or a session resume.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { DSH_HOME } from './ssh.js'

export const WORKSPACES_ROOT = path.join(DSH_HOME, 'ssh-workspace', 'workspaces')
export const BINDING_FILE = '.dsh-ssh.json'

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'root'
}

function hashOf(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 10)
}

function bindingPath(dir) {
  return path.join(dir, BINDING_FILE)
}

/** Read the binding recorded in `dir` (not its parents). */
export function readBinding(dir) {
  let text
  try {
    text = fs.readFileSync(bindingPath(dir), 'utf8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(text)
    if (!data || data.version !== 1 || !data.alias || !data.remotePath) return null
    return { ...data, localPath: dir }
  } catch {
    return null
  }
}

/** Resolve the binding for a session cwd, checking cwd and its ancestors. */
export function bindingForCwd(cwd) {
  if (!cwd) return null
  const resolved = path.resolve(String(cwd))
  if (!resolved.startsWith(WORKSPACES_ROOT + path.sep) && resolved !== WORKSPACES_ROOT) return null
  let dir = resolved
  for (let depth = 0; depth < 8; depth += 1) {
    const binding = readBinding(dir)
    if (binding) return binding
    const parent = path.dirname(dir)
    if (parent === dir || parent.length < WORKSPACES_ROOT.length) break
    dir = parent
  }
  return null
}

export function bindingDirFor(alias, remotePath) {
  return path.join(WORKSPACES_ROOT, safeName(alias), `${safeName(path.posix.basename(remotePath) || 'root')}-${hashOf(`${alias}\u0000${remotePath}`)}`)
}

/**
 * Create (or reuse) the sentinel directory for a remote path. A pre-existing
 * binding is returned as-is so creating twice never orphans the earlier one.
 */
export async function createBinding({ alias, remotePath, hostname = '', user = '', port = 22 }) {
  const localPath = bindingDirFor(alias, remotePath)
  const existing = readBinding(localPath)
  if (existing) return existing
  await fsp.mkdir(localPath, { recursive: true, mode: 0o755 })
  const data = {
    version: 1,
    alias,
    remotePath,
    hostname,
    user,
    port,
    createdAt: new Date().toISOString(),
    label: `${alias}:${remotePath}`,
  }
  await fsp.writeFile(bindingPath(localPath), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return { ...data, localPath }
}

export async function listBindings() {
  const result = []
  let hosts
  try {
    hosts = await fsp.readdir(WORKSPACES_ROOT, { withFileTypes: true })
  } catch {
    return result
  }
  for (const hostDir of hosts) {
    if (!hostDir.isDirectory()) continue
    const hostPath = path.join(WORKSPACES_ROOT, hostDir.name)
    let dirs
    try {
      dirs = await fsp.readdir(hostPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const binding = readBinding(path.join(hostPath, dir.name))
      if (binding) result.push(binding)
    }
  }
  result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return result
}

export async function forgetBinding(localPath) {
  const target = path.resolve(String(localPath))
  if (!target.startsWith(WORKSPACES_ROOT + path.sep)) throw new Error('refusing to touch a path outside the ssh workspace root')
  const binding = readBinding(target)
  if (!binding) throw new Error('not a remote workspace directory')
  await fsp.rm(bindingPath(target), { force: true })
  try {
    await fsp.rmdir(target)
  } catch {
    // Extra files left in the sentinel dir: keep the folder, binding is gone.
  }
  return binding
}
