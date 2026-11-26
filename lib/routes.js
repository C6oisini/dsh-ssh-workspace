// JSON routes for the workspace panel. These are ordinary webServer routes
// under /dsh-ssh/; on Desktop the same handlers are reachable through the
// Connection Fetch carrier as /api/dsh-ssh/... (see lib/http.js).

import fs from 'node:fs'
import path from 'node:path'

import { createBinding, forgetBinding, listBindings, readBinding, WORKSPACES_ROOT } from './binding.js'
import { listRemoteDir, pingHost, remoteInstructions, sshHosts } from './ssh.js'

const MAX_BODY = 1024 * 1024

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { httpStatus: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { httpStatus: 400 })
  }
}

function hostOf(alias) {
  const host = sshHosts().find((entry) => entry.alias === alias)
  if (!host) throw Object.assign(new Error(`unknown SSH host: ${alias}`), { httpStatus: 404 })
  return host
}

export function createRoutes() {
  return [
    {
      kind: 'exact',
      path: '/dsh-ssh/hosts',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const hosts = sshHosts().map((host) => ({
          ...host,
          workspaces: listBindingsSync().filter((binding) => binding.alias === host.alias).length,
        }))
        sendJson(res, 200, { ok: true, hosts, root: WORKSPACES_ROOT })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh/ping',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const url = new URL(req.url, 'http://localhost')
          const alias = String(url.searchParams.get('alias') || '')
          hostOf(alias)
          const result = await pingHost(alias)
          sendJson(res, 200, { ok: result.ok, alias, error: result.error || '' })
        } catch (error) {
          sendJson(res, error.httpStatus || 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh/ls',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const url = new URL(req.url, 'http://localhost')
          const alias = String(url.searchParams.get('alias') || '')
          const wanted = String(url.searchParams.get('path') || '')
          hostOf(alias)
          const target = wanted ? path.posix.normalize(wanted) : null
          const listing = await listRemoteDir(alias, target)
          sendJson(res, 200, { ok: true, alias, path: listing.path, entries: listing.entries })
        } catch (error) {
          sendJson(res, error.httpStatus || 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh/workspaces',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const workspaces = await listBindings()
          sendJson(res, 200, { ok: true, workspaces, root: WORKSPACES_ROOT })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh/bind',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const alias = String(body.alias || '')
          const remotePath = String(body.remotePath || '')
          if (!alias || !remotePath) return sendJson(res, 400, { ok: false, error: 'alias and remotePath are required' })
          const host = hostOf(alias)
          const normalized = path.posix.normalize(remotePath)
          if (!path.posix.isAbsolute(normalized)) return sendJson(res, 400, { ok: false, error: 'remotePath must be absolute' })
          const binding = await createBinding({
            alias,
            remotePath: normalized,
            hostname: host.hostname,
            user: host.user,
            port: host.port,
          })
          // Warm the AGENTS.md cache so the first prompt of the new session
          // already has the project instructions.
          remoteInstructions(binding.alias, binding.remotePath)
          sendJson(res, 200, { ok: true, binding })
        } catch (error) {
          sendJson(res, error.httpStatus || 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh/forget',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const localPath = String(body.localPath || '')
          if (!localPath) return sendJson(res, 400, { ok: false, error: 'localPath is required' })
          const binding = readBinding(path.resolve(localPath))
          if (!binding) return sendJson(res, 404, { ok: false, error: 'not a remote workspace' })
          await forgetBinding(localPath)
          sendJson(res, 200, { ok: true, binding })
        } catch (error) {
          sendJson(res, error.httpStatus || 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    },
  ]
}

function listBindingsSync() {
  // The /hosts route only needs a count; a synchronous scan keeps it simple.
  try {
    return fs.readdirSync(WORKSPACES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((hostDir) => {
        try {
          return fs.readdirSync(path.join(WORKSPACES_ROOT, hostDir.name), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => readBinding(path.join(WORKSPACES_ROOT, hostDir.name, entry.name)))
            .filter(Boolean)
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
