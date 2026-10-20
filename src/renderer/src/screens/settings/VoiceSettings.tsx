import { useEffect, useState, type ReactElement } from 'react'
import { HOLD_TO_TALK, LANGUAGES, WHISPER_SIZES, type WhisperSize } from '@shared/voice'
import { StatusPill, Switch } from '../../components/ui'
import { DictationStatus, useDictation, useVoice } from '../../voice/voice'

function useMicrophones(): { devices: MediaDeviceInfo[]; refresh: () => void } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const refresh = (): void => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setDevices(all.filter((device) => device.kind === 'audioinput')))
      .catch(() => setDevices([]))
  }
  useEffect(refresh, [])
  return { devices, refresh }
}

function TryIt({ onHeard }: { onHeard: () => void }): ReactElement {
  const voice = useVoice()
  const [heard, setHeard] = useState('')
  const dictation = useDictation((text) => setHeard(text))
  const listening = dictation.state === 'listening'
  return (
    <section className="panel" aria-label="Try it">
      <h2 style={{ fontSize: 16 }}>Try it</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`er-btn${listening ? ' er-btn-primary' : ''}`}
          disabled={!voice.usable || dictation.state === 'transcribing'}
          onClick={() => {
            if (listening) void dictation.stop().then(onHeard)
            else void dictation.start()
          }}
        >
          {listening ? 'Stop' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Start talking'}
        </button>
      </div>
      <DictationStatus dictation={dictation} finishHint="Say a sentence, then press Stop." />
      {!voice.usable && <span className="muted">Download a model above first.</span>}
      {heard && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--surface-25, #F7F8FB)' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Heard
          </span>
          <div>{heard}</div>
        </div>
      )}
      {dictation.error && <span className="error-text">{dictation.error === 'No microphone found' ? 'No microphone found. In WSL, the microphone reaches the app through WSLg; check Windows › Privacy › Microphone allows desktop apps.' : dictation.error}</span>}
    </section>
  )
}

/** Dictation: local Whisper (nothing leaves this machine) or the operating system's own. */
export function VoiceSettings(): ReactElement {
  const voice = useVoice()
  const { settings } = voice
  const { devices, refresh } = useMicrophones()
  const set = (patch: Partial<typeof settings>): void => voice.setSettings({ ...settings, ...patch })
  const named = devices.some((device) => device.label)
  const state = {
    checking: { status: 'neutral' as const, label: 'Checking…' },
    missing: { status: 'neutral' as const, label: 'Not downloaded' },
    downloading: { status: 'running' as const, label: `Downloading ${Math.round(voice.progress * 100)}%` },
    loading: { status: 'running' as const, label: 'Loading…' },
    ready: { status: 'passed' as const, label: 'Ready' },
    error: { status: 'failed' as const, label: 'Failed' }
  }[voice.modelState]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 820 }}>
      <section className="panel" aria-label="Engine">
        <h2 style={{ fontSize: 18 }}>Voice</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="radio" name="engine" checked={settings.engine === 'whisper'} onChange={() => set({ engine: 'whisper' })} />
          <span>
            <strong>Whisper on this machine</strong>
            <span className="muted" style={{ display: 'block', fontSize: 13 }}>
              Works offline once downloaded; your voice never leaves your computer. A mic button appears in every message box.
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="radio" name="engine" checked={settings.engine === 'system'} onChange={() => set({ engine: 'system' })} />
          <span>
            <strong>Your system's dictation</strong>
            <span className="muted" style={{ display: 'block', fontSize: 13 }}>
              Nothing to download, and the mic button is hidden. On Windows press Win+H in a message box; on macOS, press the dictation key.
            </span>
          </span>
        </label>
      </section>

      {settings.engine === 'whisper' && (
        <>
          <section className="panel" aria-label="Whisper model">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 16 }}>Model</h2>
              <StatusPill status={state.status}>{state.label}</StatusPill>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {voice.model}
              </span>
            </div>
            {(Object.keys(WHISPER_SIZES) as WhisperSize[]).map((size) => (
              <label key={size} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="radio" name="size" checked={settings.size === size} onChange={() => set({ size })} />
                {WHISPER_SIZES[size].label}
                <span className="muted" style={{ fontSize: 13 }}>
                  {WHISPER_SIZES[size].download}
                </span>
              </label>
            ))}
            {voice.modelState === 'downloading' && (
              <div style={{ height: 8, borderRadius: 4, background: 'var(--divider-100)' }}>
                <div style={{ width: `${Math.round(voice.progress * 100)}%`, height: 8, borderRadius: 4, background: 'var(--primary-600)' }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {(voice.modelState === 'missing' || voice.modelState === 'error') && (
                <button type="button" className="er-btn er-btn-primary" onClick={voice.download}>
                  Download {WHISPER_SIZES[settings.size].download.replace('about ', '')}
                </button>
              )}
              {voice.modelState === 'ready' && (
                <button type="button" className="er-btn" onClick={() => void voice.remove()}>
                  Remove
                </button>
              )}
            </div>
            <span className="muted" style={{ fontSize: 13 }}>
              Downloads once from Hugging Face and stays in Eregion's app data. English uses the English-only model, which is more accurate for English.
            </span>
            {voice.error && <span className="error-text">{voice.error}</span>}
          </section>

          <section className="panel" aria-label="Voice options">
            <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 320px)', gap: '10px 12px', alignItems: 'center' }}>
              <label className="muted" htmlFor="voice-language">
                Language
              </label>
              <select id="voice-language" className="select" value={settings.language} onChange={(event) => set({ language: event.target.value })}>
                {LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
              <label className="muted" htmlFor="voice-mic">
                Microphone
              </label>
              <select id="voice-mic" className="select" value={settings.microphoneId ?? ''} onChange={(event) => set({ microphoneId: event.target.value || null })} onFocus={refresh}>
                <option value="">System default</option>
                {devices
                  .filter((device) => device.deviceId && device.deviceId !== 'default')
                  .map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
              </select>
              <span className="muted">Hold to talk</span>
              <span>
                <kbd className="mono">{HOLD_TO_TALK}</kbd> <span className="muted">in any message box</span>
              </span>
            </div>
            {!named && devices.length > 0 && <span className="muted" style={{ fontSize: 13 }}>Microphone names show once you've allowed the microphone with Try it.</span>}
            <Switch label="Send as soon as I let go (otherwise the words wait in the box to be checked)" checked={settings.sendOnRelease} onChange={(sendOnRelease) => set({ sendOnRelease })} />
          </section>

          <TryIt onHeard={refresh} />
        </>
      )}
    </div>
  )
}
