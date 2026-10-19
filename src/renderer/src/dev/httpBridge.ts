import { API_METHODS, type EregionBridge, type EregionEvent } from '@shared/api'

/**
 * Used only by the development web preview (npm run preview:web), where there is no Electron
 * preload script. Calls the same API over HTTP. Folder picking falls back to a prompt.
 */
export function createHttpBridge(): EregionBridge {
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    const body = (await response.json()) as { result?: unknown; error?: string }
    if (body.error) throw new Error(body.error)
    return body.result
  }
  const bridge = Object.fromEntries(API_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)])) as Record<string, unknown>
  bridge.pickFolder = async () => window.prompt('Repo folder path (web preview)') || null
  bridge.onEvent = (listener: (event: EregionEvent) => void) => {
    const source = new EventSource('/events')
    source.onmessage = (message) => listener(JSON.parse(message.data) as EregionEvent)
    return () => source.close()
  }
  return bridge as unknown as EregionBridge
}
