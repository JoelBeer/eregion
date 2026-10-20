import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { DEFAULT_VOICE, whisperModel, type VoiceSettings } from '@shared/voice'

const CACHE = 'transformers-cache'
const SAMPLE_RATE = 16_000

/** `loading` is a model already downloaded, being read from the cache into the worker. */
export type ModelState = 'checking' | 'missing' | 'downloading' | 'loading' | 'ready' | 'error'

interface Voice {
  settings: VoiceSettings
  setSettings(settings: VoiceSettings): void
  model: string
  modelState: ModelState
  /** 0 to 1 while downloading. */
  progress: number
  error: string | null
  download(): void
  remove(): Promise<void>
  transcribe(audio: Float32Array): Promise<string>
  /** True when dictation can start: Whisper chosen and its model ready, or loading (the words wait for it). */
  usable: boolean
}

const VoiceContext = createContext<Voice | null>(null)

/** Whether a model's files are in the app's cache already. */
async function cached(model: string): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE)
    return (await cache.keys()).some((request) => request.url.includes(`/${model}/`))
  } catch {
    return false
  }
}

/** Whisper settings, the model download, and one transcription worker for the whole window. */
export function VoiceProvider({ children }: { children: ReactNode }): ReactElement {
  const [settings, setSettingsState] = useState<VoiceSettings>(DEFAULT_VOICE)
  const [modelState, setModelState] = useState<ModelState>('checking')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const worker = useRef<Worker | null>(null)
  const pending = useRef(new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>())
  const nextId = useRef(1)
  const files = useRef(new Map<string, { loaded: number; total: number }>())
  const model = whisperModel(settings.size, settings.language)

  useEffect(() => {
    void window.eregion.getSetting('voice', DEFAULT_VOICE).then((stored) => setSettingsState({ ...DEFAULT_VOICE, ...stored }))
  }, [])

  const getWorker = useCallback((): Worker => {
    if (worker.current) return worker.current
    const created = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    created.onmessage = (event: MessageEvent<{ type: string; id?: number; text?: string; message?: string; file?: string; loaded?: number; total?: number }>) => {
      const message = event.data
      if (message.type === 'progress' && message.total) {
        files.current.set(message.file ?? '', { loaded: message.loaded ?? 0, total: message.total })
        const all = [...files.current.values()]
        setProgress(Math.min(1, all.reduce((sum, file) => sum + file.loaded, 0) / all.reduce((sum, file) => sum + file.total, 0)))
      }
      if (message.type === 'ready') {
        setModelState('ready')
        setProgress(1)
      }
      if (message.type === 'text' && message.id) {
        pending.current.get(message.id)?.resolve(message.text ?? '')
        pending.current.delete(message.id)
      }
      if (message.type === 'error') {
        if (message.id && pending.current.has(message.id)) {
          pending.current.get(message.id)?.reject(new Error(message.message))
          pending.current.delete(message.id)
        } else {
          setModelState('error')
          setError(message.message ?? 'Whisper failed to load')
        }
      }
    }
    worker.current = created
    return created
  }, [])

  // A model already in the cache loads straight away; a missing one waits for Download.
  useEffect(() => {
    if (settings.engine !== 'whisper') return
    let cancelled = false
    setModelState('checking')
    void cached(model).then((present) => {
      if (cancelled) return
      if (present) {
        setModelState('loading')
        getWorker().postMessage({ type: 'load', model })
      } else setModelState('missing')
    })
    return () => {
      cancelled = true
    }
  }, [model, settings.engine, getWorker])

  const value: Voice = {
    settings,
    setSettings: (next) => {
      setSettingsState(next)
      void window.eregion.setSetting('voice', next)
    },
    model,
    modelState,
    progress,
    error,
    download: () => {
      setError(null)
      setProgress(0)
      setModelState('downloading')
      getWorker().postMessage({ type: 'load', model })
    },
    remove: async () => {
      const cache = await caches.open(CACHE)
      for (const request of await cache.keys()) if (request.url.includes(`/${model}/`)) await cache.delete(request)
      worker.current?.terminate()
      worker.current = null
      setModelState('missing')
    },
    transcribe: (audio) =>
      new Promise((resolve, reject) => {
        const id = nextId.current++
        pending.current.set(id, { resolve, reject })
        getWorker().postMessage({ type: 'transcribe', id, audio, language: settings.language }, [audio.buffer])
      }),
    usable: settings.engine === 'whisper' && (modelState === 'ready' || modelState === 'loading')
  }
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoice(): Voice {
  const voice = useContext(VoiceContext)
  if (!voice) throw new Error('useVoice needs a VoiceProvider')
  return voice
}

export interface Recording {
  /** The input level now, 0 to 1, for a meter. */
  level(): number
  stop(): Promise<Float32Array>
}

/** Records the microphone at 16 kHz mono, the way Whisper wants it. */
export async function startRecording(deviceId: string | null): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const audio = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = audio.createMediaStreamSource(stream)
  const analyser = audio.createAnalyser()
  analyser.fftSize = 512
  const recorder = audio.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  recorder.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  source.connect(analyser)
  source.connect(recorder)
  recorder.connect(audio.destination)
  const samples = new Float32Array(analyser.fftSize)
  return {
    level: () => {
      analyser.getFloatTimeDomainData(samples)
      let peak = 0
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
      return Math.min(1, peak * 2)
    },
    stop: async () => {
      recorder.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      await audio.close()
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const all = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.length
      }
      return all
    }
  }
}

export interface Dictation {
  state: 'idle' | 'listening' | 'transcribing'
  /** When the current state began (ms since the epoch), for a timer. */
  since: number
  level: number
  error: string | null
  start(viaShortcut?: boolean): Promise<void>
  stop(): Promise<void>
}

/** Dictation for one composer: start, stop, and the words that came back. */
export function useDictation(onText: (text: string, viaShortcut: boolean) => void): Dictation {
  const voice = useVoice()
  const [state, setStateOnly] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const [since, setSince] = useState(0)
  const setState = (next: 'idle' | 'listening' | 'transcribing'): void => {
    setStateOnly(next)
    setSince(Date.now())
  }
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recording = useRef<Recording | null>(null)
  const shortcut = useRef(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = async (): Promise<void> => {
    const current = recording.current
    if (!current) return
    recording.current = null
    if (timer.current) clearInterval(timer.current)
    setLevel(0)
    setState('transcribing')
    try {
      const audio = await current.stop()
      // Under a third of a second is a slip of the key, not speech.
      if (audio.length > SAMPLE_RATE / 3) {
        const text = await voice.transcribe(audio)
        if (text) onText(text, shortcut.current)
      }
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setState('idle')
    }
  }

  const start = async (viaShortcut = false): Promise<void> => {
    if (recording.current || !voice.usable) return
    setError(null)
    shortcut.current = viaShortcut
    try {
      recording.current = await startRecording(voice.settings.microphoneId)
      setState('listening')
      timer.current = setInterval(() => setLevel(recording.current?.level() ?? 0), 80)
    } catch (caught) {
      setError(caught instanceof DOMException && caught.name === 'NotFoundError' ? 'No microphone found' : (caught as Error).message)
    }
  }

  return { state, since, level, error, start, stop }
}

function useSecondsSince(since: number, running: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [running, since])
  return Math.max(0, Math.floor((now - since) / 1000))
}

/**
 * What dictation is doing, in words, while it's doing it: listening (with a level meter and a timer),
 * then transcribing (with a spinner), so it never looks as if nothing happened. Nothing shows when idle.
 */
export function DictationStatus({ dictation, finishHint }: { dictation: Dictation; finishHint: string }): ReactElement | null {
  const voice = useVoice()
  const seconds = useSecondsSince(dictation.since, dictation.state !== 'idle')
  if (dictation.state === 'idle') return null
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <div className="er-dictation" role="status" aria-live="polite">
      {dictation.state === 'listening' ? (
        <>
          <span className="er-dictation-dot" aria-hidden />
          <strong>Listening</strong>
          <span className="mono">{clock}</span>
          <span className="er-dictation-meter" aria-hidden>
            <span style={{ width: `${Math.round(dictation.level * 100)}%` }} />
          </span>
          <span className="er-dictation-hint">{finishHint}</span>
        </>
      ) : (
        <>
          <span className="er-spinner" aria-hidden />
          <strong>{voice.modelState === 'loading' ? 'Loading the speech model, then transcribing' : 'Transcribing what you said'}</strong>
          <span className="mono">{seconds}s</span>
          <span className="er-dictation-hint">Whisper runs on this machine, so a long recording takes a little while.</span>
        </>
      )}
    </div>
  )
}
