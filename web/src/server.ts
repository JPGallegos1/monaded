/**
 * Custom Cloudflare Worker entry for TanStack Start.
 * Proxies `/api/*` to edtech-monad-api via the `API` service binding so the
 * session cookie is first-party (workers.dev is on the public suffix list —
 * cross-subdomain SameSite=Lax cookies are not sent on fetch).
 */
import handler from '@tanstack/react-start/server-entry'

type Env = {
  API: Fetcher
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!env.API) {
        return new Response(JSON.stringify({ error: 'API binding not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const upstreamPath = url.pathname.slice('/api'.length) || '/'
      const target = `https://edtech-monad-api.internal${upstreamPath}${url.search}`
      const headers = new Headers(request.headers)
      headers.delete('host')
      const init: RequestInit & { duplex?: string } = {
        method: request.method,
        headers,
        redirect: 'manual',
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body
        init.duplex = 'half'
      }
      return env.API.fetch(new Request(target, init))
    }
    return handler.fetch(request)
  },
}
