import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './ds.css'
import './app.css'
import { App } from './App'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
