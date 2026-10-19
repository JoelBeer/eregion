import { join } from 'node:path'
import { userInfo } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import { API_METHODS, type EregionApi, type EregionEvent } from '@shared/api'
import { createBackend, type Backend, type Host } from './api'
import { openDatabase, type Db } from './db'
import { openUrl } from './openUrl'

let db: Db
let backend: Backend | null = null
let mainWindow: BrowserWindow | null = null

function databasePath(): string {
  return join(app.getPath('userData'), 'eregion.db')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#EAF8FB',
    title: 'Eregion',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openUrl(url, (link) => shell.openExternal(link))
    return { action: 'deny' }
  })
  // Linear issues assigned while you were away show up as soon as you come back.
  mainWindow.on('focus', () => void backend?.linearSync.syncAll().catch(() => undefined))

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const host: Host = {
  get appVersion() {
    return app.getVersion()
  },
  get databasePath() {
    return databasePath()
  },
  async pickFolder() {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Choose a repo folder' })
    return result.canceled ? null : result.filePaths[0]
  },
  async pickSaveFile(defaultName) {
    const result = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'Eregion project', extensions: ['json'] }] })
    return result.canceled || !result.filePath ? null : result.filePath
  },
  async pickOpenFile() {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Eregion project', extensions: ['json'] }] })
    return result.canceled ? null : result.filePaths[0]
  },
  async openExternal(url) {
    await openUrl(url, (link) => shell.openExternal(link))
  },
  emit(event: EregionEvent) {
    mainWindow?.webContents.send('event', event)
  },
  notify(title, body) {
    if (Notification.isSupported() && !mainWindow?.isFocused()) new Notification({ title, body }).show()
  },
  userName: userInfo().username,
  // Linear tokens are encrypted with the OS keychain where there is one (on Linux without a keyring, Electron falls back to a fixed key).
  secrets: {
    encrypt: (text) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(text).toString('base64')}` : text),
    decrypt: (text) => (text.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(text.slice(4), 'base64')) : text)
  }
}

function registerIpc(api: EregionApi): void {
  const allowed = new Set<string>(API_METHODS)
  ipcMain.handle('api', async (_event, method: string, args: unknown[]) => {
    if (!allowed.has(method)) throw new Error(`Unknown API method: ${method}`)
    const handler = api[method as keyof EregionApi] as (...params: unknown[]) => Promise<unknown>
    return handler(...args)
  })
}

app.whenReady().then(() => {
  db = openDatabase(databasePath())
  backend = createBackend(db, host, { timers: true })
  registerIpc(backend.api)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !backend) return
  // Stop the services Eregion started (dev servers and the like) before the app goes.
  event.preventDefault()
  quitting = true
  void backend.shutdown().finally(() => app.quit())
})

app.on('will-quit', () => {
  db?.close()
})
