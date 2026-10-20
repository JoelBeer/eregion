import { join } from 'node:path'
import { userInfo } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, screen, shell } from 'electron'
import { API_METHODS, type EregionApi, type EregionEvent } from '@shared/api'
import { createBackend, type Backend, type Host } from './api'
import { openDatabase, type Db } from './db'
import { openUrl } from './openUrl'

let db: Db
let backend: Backend | null = null
let mainWindow: BrowserWindow | null = null
// One Eregion at a time: they would share the database. Opening it again brings this window back.
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()

function databasePath(): string {
  return join(app.getPath('userData'), 'eregion.db')
}

/** The anvil, for the window and taskbar. Packaged apps carry their own icon. */
function iconPath(): string | undefined {
  return app.isPackaged ? undefined : join(__dirname, '../../build/icon.png')
}

function createWindow(): void {
  // Frameless, with the app's own title bar: the name and the window buttons on one row. (Inside WSL this
  // needs Wayland mode, from scripts/electron-flags.mjs; under X11, WSLg covers the top of a frameless window
  // with an invisible title strip of its own that takes every click.)
  const customTitleBar = true
  const query = { frame: customTitleBar ? 'app' : 'native' }
  // Fill the screen even where a maximise request is ignored.
  const area = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.max(960, area.width),
    height: Math.max(640, area.height),
    minWidth: 960,
    minHeight: 640,
    frame: !customTitleBar,
    backgroundColor: '#0B6594',
    title: 'Eregion',
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  // Shown at once rather than on ready-to-show: under Wayland (inside WSL) a window that was never shown gets
  // no frames from the compositor, so the page may never paint, ready-to-show never comes and the window never
  // appears. The background colour covers the moment before the page draws.
  mainWindow.maximize()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  const sendMaximized = (): void => mainWindow?.webContents.send('window', { maximized: mainWindow.isMaximized() })
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openUrl(url, (link) => shell.openExternal(link))
    return { action: 'deny' }
  })
  // Linear issues assigned while you were away show up as soon as you come back.
  mainWindow.on('focus', () => void backend?.linearSync.syncAll().catch(() => undefined))

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}`)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
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
  // The title bar's buttons.
  ipcMain.handle('window', (_event, action: 'minimize' | 'toggle-maximize' | 'close' | 'is-maximized') => {
    if (!mainWindow) return false
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'toggle-maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
    if (action === 'close') mainWindow.close()
    return mainWindow.isMaximized()
  })
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(() => {
  if (!firstInstance) return
  // No File / Edit / View menu: everything lives in the app itself.
  Menu.setApplicationMenu(null)
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
