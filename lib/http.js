// Dual HTTP transport for the panel routes.
//
// DSH Web serves plugin routes from `webServer`; portless Desktop reaches the
// same handlers through Connection's authenticated Fetch carrier at
// /api/<route>. Registering both keeps the panel working in either host.
// The browser fence mirrors DSH's own /api policy: a cross-site page must not
// be able to create or delete workspace bindings.

import { Readable } from 'node:stream'

const MAX_BODY_BYTES = 1024 * 1024

function fallbackRejection(req) {
  const headers = req && req.headers
  if (!headers || typeof headers !== 'object') return undefined
  const header = (name) => {
    const value = headers[name]
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }
  if (header('sec-fetch-site') === 'cross-site') return 403
  const host = header('host')
  const origin = header('origin')
  if (origin !== undefined && host !== undefined) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  if (host !== undefined) {
    const hostname = host.replace(/:\d+$/, '').toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    if (!loopback) return 403
  }
  return undefined
}

function guardRoute(route, connectionOf) {
  const inner = route.handler
  return {
    ...route,
    handler: async (req, res) => {
      const connection = connectionOf()
      const rejection = typeof connection?.requestRejection === 'function'
        ? connection.requestRejection(req)
        : fallbackRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      return inner(req, res)
    },
  }
}

function connectionRoute(route) {
  if (!route.path.startsWith('/dsh-ssh/')) throw new Error('dsh-ssh-workspace: expected a route under /dsh-ssh/')
  return {
    path: '/api' + route.path,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const reader = request.body?.getReader()
      const chunks = []
      let size = 0
      try {
        if (reader) {
          while (true) {
            request.signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY_BYTES) {
              await reader.cancel()
              return Response.json({ ok: false, error: 'request body too large' }, { status: 413 })
            }
            chunks.push(Buffer.from(value))
          }
        }
      } finally {
        reader?.releaseLock()
      }
      request.signal.throwIfAborted()
      const url = new URL(request.url)
      const req = Readable.from(size ? [Buffer.concat(chunks, size)] : [])
      req.method = request.method
      req.url = route.path + url.search
      const headers = new Headers()
      let response
      const res = {
        statusCode: 200,
        setHeader(key, value) { headers.set(key, value) },
        writeHead(status, extra) {
          this.statusCode = status
          if (extra && typeof extra === 'object') for (const [key, value] of Object.entries(extra)) headers.set(key, value)
        },
        end(body) { response = new Response(body, { status: this.statusCode, headers }) },
      }
      try {
        await route.handler(req, res)
        if (!response) throw new Error('JSON handler did not finish its response')
        return response
      } finally {
        req.destroy()
      }
    },
  }
}

export function registerHttpTransports(ctx, routes) {
  ctx.inject(['webServer'], (inner) => {
    const guarded = routes.map((route) => guardRoute(route, () => ctx.get('connection')))
    const disposers = guarded.map((route) => inner.get('webServer').register(route))
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-ssh-workspace.web-routes')
  })
  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (typeof connection.fetch?.register !== 'function') return
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(connection.fetch.register(connectionRoute(route)))
      } catch (error) {
        console.warn('[dsh-ssh-workspace] fetch route failed:', route.path, String((error && error.message) || error))
      }
    }
    inner.effect(() => () => Promise.all(disposers.map((dispose) => dispose())), 'dsh-ssh-workspace.fetch-routes')
  })
}
