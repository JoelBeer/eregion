/** Voice dictation: local Whisper in the app, or the operating system's own dictation. */

export type WhisperSize = 'base' | 'small'

export interface VoiceSettings {
  /** `whisper` transcribes on this machine; `system` hides the mic button and leaves it to OS dictation. */
  engine: 'whisper' | 'system'
  size: WhisperSize
  /** A Whisper language code; English uses the smaller English-only models. */
  language: string
  /** A microphone's deviceId, or null for the system default. */
  microphoneId: string | null
  /** Send as soon as the hold-to-talk key is let go, instead of leaving the words to edit. */
  sendOnRelease: boolean
}

export const DEFAULT_VOICE: VoiceSettings = { engine: 'whisper', size: 'base', language: 'en', microphoneId: null, sendOnRelease: false }

export const HOLD_TO_TALK = 'Ctrl+Space'

export const WHISPER_SIZES: Record<WhisperSize, { label: string; download: string }> = {
  base: { label: 'Base: faster', download: 'about 150 MB' },
  small: { label: 'Small: more accurate', download: 'about 480 MB' }
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pt', label: 'Portuguese' }
]

/** The model for a size and language: English gets the English-only model, which is better at English. */
export function whisperModel(size: WhisperSize, language: string): string {
  return `onnx-community/whisper-${size}${language === 'en' ? '.en' : ''}`
}
