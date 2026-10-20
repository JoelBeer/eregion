import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

/**
 * Whisper in a worker, so transcribing never freezes the window. Models download from Hugging Face
 * the first time they're loaded and stay in the app's cache; nothing else leaves the machine.
 */
env.allowLocalModels = false

/** The worker's own scope: the renderer's DOM types would want a target origin on postMessage. */
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<Request>) => void) | null }

type Request = { type: 'load'; model: string } | { type: 'transcribe'; id: number; audio: Float32Array; language: string }

let loaded: { model: string; asr: AutomaticSpeechRecognitionPipeline } | null = null

async function load(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (loaded?.model === model) return loaded.asr
  const asr = (await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (progress: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (progress.status === 'progress' && progress.total) scope.postMessage({ type: 'progress', file: progress.file, loaded: progress.loaded, total: progress.total })
    }
  })) as AutomaticSpeechRecognitionPipeline
  loaded = { model, asr }
  return asr
}

scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.type === 'load') {
      await load(request.model)
      scope.postMessage({ type: 'ready', model: request.model })
    } else if (request.type === 'transcribe') {
      if (!loaded) throw new Error('Load a Whisper model first')
      const english = loaded.model.endsWith('.en')
      const output = await loaded.asr(request.audio, english ? {} : { language: request.language, task: 'transcribe' })
      const text = (Array.isArray(output) ? output.map((item) => item.text).join(' ') : output.text).trim()
      scope.postMessage({ type: 'text', id: request.id, text })
    }
  } catch (error) {
    scope.postMessage({ type: 'error', id: 'id' in request ? request.id : null, message: (error as Error).message })
  }
}
