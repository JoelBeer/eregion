import { useCallback, useEffect, useRef, useState } from 'react'
import type { EregionEvent } from '@shared/api'

export interface Query<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

/**
 * Loads data from the main process and reloads it whenever an event matches `refreshOn`.
 * Errors are kept as a message for the screen to show.
 */
export function useQuery<T>(load: () => Promise<T>, deps: unknown[], refreshOn?: (event: EregionEvent) => boolean): Query<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  loadRef.current = load
  const refreshRef = useRef(refreshOn)
  refreshRef.current = refreshOn

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await loadRef.current())
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(
    () =>
      window.eregion.onEvent((event) => {
        if (refreshRef.current?.(event)) void reload()
      }),
    [reload]
  )

  return { data, error, loading, reload }
}

/** Electron prefixes errors thrown in the main process; keep only the message the user needs. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Runs an action and keeps its pending state and error for the button that started it. */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): {
  run: (...args: A) => Promise<R | undefined>
  pending: boolean
  error: string | null
  clearError: () => void
} {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(
    async (...args: A) => {
      setPending(true)
      setError(null)
      try {
        return await action(...args)
      } catch (caught) {
        setError(errorMessage(caught))
        return undefined
      } finally {
        setPending(false)
      }
    },
    [action]
  )
  return { run, pending, error, clearError: () => setError(null) }
}
