/**
 * Development preview without Electron: serves the built renderer and the real API over HTTP, so
 * the UI can be checked in any browser. Not shipped in the app. Start with `npm run preview:web`.
 */
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { API_METHODS, type EregionApi, type EregionEvent } from '@shared/api'
import { createBackend } from '../main/api'
import { openDatabase } from '../main/db'

const PORT = Number(process.env.EREGION_WEB_PORT ?? 5199)
const RENDERER = join(process.cwd(), 'out', 'renderer')
const DATA = process.env.EREGION_WEB_DATA ?? join(tmpdir(), 'eregion-web')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

const listeners = new Set<ServerResponse>()

async function main(): Promise<void> {
  await mkdir(DATA, { recursive: true })
  const databasePath = join(DATA, 'eregion.db')
  const { api, shutdown } = createBackend(openDatabase(databasePath), {
    appVersion: '0.1.0-web',
    databasePath,
    pickFolder: async () => null,
    pickSaveFile: async (name) => join(DATA, name),
    pickOpenFile: async () => join(DATA, 'import.eregion.json'),
    openExternal: async () => undefined,
    emit: (event: EregionEvent) => {
      for (const listener of listeners) listener.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  })
  process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
  const allowed = new Set<string>(API_METHODS)

  createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
    if (url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      listeners.add(response)
      request.on('close', () => listeners.delete(response))
      return
    }
    if (url.pathname.startsWith('/api/') && request.method === 'POST') {
      const method = url.pathname.slice(5)
      let body = ''
      for await (const chunk of request) body += chunk
      response.setHeader('content-type', 'application/json')
      if (!allowed.has(method)) {
        response.writeHead(404).end(JSON.stringify({ error: `Unknown API method: ${method}` }))
        return
      }
      try {
        const handler = api[method as keyof EregionApi] as (...args: unknown[]) => Promise<unknown>
        const result = await handler(...(JSON.parse(body || '[]') as unknown[]))
        response.end(JSON.stringify({ result: result ?? null }))
      } catch (error) {
        response.writeHead(500).end(JSON.stringify({ error: (error as Error).message }))
      }
      return
    }
    const file = normalize(join(RENDERER, url.pathname === '/' ? 'index.html' : url.pathname))
    if (!file.startsWith(RENDERER)) {
      response.writeHead(403).end()
      return
    }
    try {
      await stat(file)
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(response)
    } catch {
      response.writeHead(404).end('Not found')
    }
  }).listen(PORT, () => console.log(`Eregion web preview on http://localhost:${PORT} (data in ${DATA})`))
}

void main()
