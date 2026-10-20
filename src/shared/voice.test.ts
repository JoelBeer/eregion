import { describe, expect, it } from 'vitest'
import { whisperModel } from './voice'

describe('whisperModel', () => {
  it('uses the English-only model for English and the multilingual one otherwise', () => {
    expect(whisperModel('base', 'en')).toBe('onnx-community/whisper-base.en')
    expect(whisperModel('small', 'fr')).toBe('onnx-community/whisper-small')
  })
})
