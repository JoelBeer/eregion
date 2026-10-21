import { useEffect, useState, type ReactElement } from 'react'
import { Logo } from './icons'

const frame = (): string | null => new URLSearchParams(window.location.search).get('frame')

/** Whether the app draws its own title bar: in Electron when the window is frameless, or on macOS with the traffic lights inset. */
export const hasTitleBar = (): boolean => Boolean(window.eregionWindow) && (frame() === 'app' || frame() === 'mac')

function Glyph({ kind }: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }): ReactElement {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.2}>
      {kind === 'minimize' && <path d="M1.5 6h9" />}
      {kind === 'maximize' && <rect x={1.5} y={1.5} width={9} height={9} rx={1} />}
      {kind === 'restore' && (
        <>
          <rect x={1.5} y={3.5} width={7} height={7} rx={1} />
          <path d="M3.5 3.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
        </>
      )}
      {kind === 'close' && <path d="M2 2l8 8M10 2l-8 8" />}
    </svg>
  )
}

/** One row: the anvil and the name on the left, the window buttons on the right. Drag it to move the window. */
export function TitleBar(): ReactElement | null {
  const controls = window.eregionWindow
  const [maximized, setMaximized] = useState(true)
  useEffect(() => {
    if (!controls) return
    void controls.isMaximized().then(setMaximized)
    return controls.onMaximizedChange(setMaximized)
  }, [controls])
  if (!controls || !hasTitleBar()) return null
  // macOS draws its own traffic lights at the left and zooms on a double-click of the bar.
  if (frame() === 'mac') {
    return (
      <header className="er-titlebar er-titlebar-mac">
        <Logo />
        <span className="er-titlebar-name">Eregion</span>
      </header>
    )
  }
  return (
    <header className="er-titlebar" onDoubleClick={() => void controls.toggleMaximize()}>
      <Logo />
      <span className="er-titlebar-name">Eregion</span>
      <div style={{ flex: 1 }} />
      <button type="button" aria-label="Minimise" onClick={() => void controls.minimize()} onDoubleClick={(event) => event.stopPropagation()}>
        <Glyph kind="minimize" />
      </button>
      <button type="button" aria-label={maximized ? 'Restore down' : 'Maximise'} onClick={() => void controls.toggleMaximize()} onDoubleClick={(event) => event.stopPropagation()}>
        <Glyph kind={maximized ? 'restore' : 'maximize'} />
      </button>
      <button type="button" className="er-titlebar-close" aria-label="Close" onClick={() => void controls.close()} onDoubleClick={(event) => event.stopPropagation()}>
        <Glyph kind="close" />
      </button>
    </header>
  )
}
