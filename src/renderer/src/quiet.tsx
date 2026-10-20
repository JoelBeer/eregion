import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

interface Playfulness {
  quiet: boolean
  setQuiet: (quiet: boolean) => void
  chime: boolean
  setChime: (chime: boolean) => void
}

const QuietContext = createContext<Playfulness>({ quiet: false, setQuiet: () => undefined, chime: true, setChime: () => undefined })

/** Two notes, softly, when something needs you. */
function playChime(): void {
  try {
    const audio = new AudioContext()
    ;[880, 1320].forEach((frequency, index) => {
      const tone = audio.createOscillator()
      const gain = audio.createGain()
      const start = audio.currentTime + index * 0.14
      tone.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35)
      tone.connect(gain).connect(audio.destination)
      tone.start(start)
      tone.stop(start + 0.4)
    })
    setTimeout(() => void audio.close(), 1000)
  } catch {
    /* No audio output: the desktop notification still shows. */
  }
}

/**
 * Quiet mode turns off the playful touches (robots on the board, speech bubbles, the chime).
 * The needs-you chime plays when something waits for you, unless it's off or Quiet mode is on.
 */
export function QuietProvider({ children }: { children: ReactNode }): ReactElement {
  const [quiet, setQuietState] = useState(false)
  const [chime, setChimeState] = useState(true)
  const current = useRef({ quiet, chime })
  current.current = { quiet, chime }
  useEffect(() => {
    void window.eregion.getSetting('ui.quiet', false).then(setQuietState)
    void window.eregion.getSetting('ui.chime', true).then(setChimeState)
    return window.eregion.onEvent((event) => {
      if (event.type === 'notice' && current.current.chime && !current.current.quiet) playChime()
    })
  }, [])
  const setQuiet = (value: boolean): void => {
    setQuietState(value)
    void window.eregion.setSetting('ui.quiet', value)
  }
  const setChime = (value: boolean): void => {
    setChimeState(value)
    void window.eregion.setSetting('ui.chime', value)
    if (value && !quiet) playChime()
  }
  return <QuietContext.Provider value={{ quiet, setQuiet, chime, setChime }}>{children}</QuietContext.Provider>
}

export function useQuiet(): Playfulness {
  return useContext(QuietContext)
}
