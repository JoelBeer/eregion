import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './ds.css'
import './app.css'
import { App } from './App'
import { QuietProvider } from './quiet'
import { createHttpBridge } from './dev/httpBridge'

// In Electron the preload script provides window.eregion. The web preview has no preload.
if (!('eregion' in window)) {
  ;(window as Window).eregion = createHttpBridge()
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QuietProvider>
      <App />
    </QuietProvider>
  </StrictMode>
)
