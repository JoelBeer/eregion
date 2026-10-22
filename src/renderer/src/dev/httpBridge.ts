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
  // One stream for every listener: a browser holds six connections to a server, and a screen has more listeners than that.
  const listeners = new Set<(event: EregionEvent) => void>()
  let source: EventSource | null = null
  bridge.onEvent = (listener: (event: EregionEvent) => void) => {
    listeners.add(listener)
    if (!source) {
      source = new EventSource('/events')
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as EregionEvent
        for (const each of [...listeners]) each(event)
      }
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        source?.close()
        source = null
      }
    }
  }
  return bridge as unknown as EregionBridge
}
