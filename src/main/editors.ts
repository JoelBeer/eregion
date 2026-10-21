import { DEFAULT_EDITOR, EDITOR_PRESETS, editorCheck, editorCommand, editorName, type EditorChoice, type EditorInfo, type EditorPlatform } from '@shared/editors'
import { getSetting, setSetting, type Db } from './db'
import { insideWsl } from './openUrl'
import type { Runner } from './runner/types'

/** Where a runner's commands run: inside WSL (where Windows editors can open the folder too), macOS or Linux. */
function platformOf(runner: Runner): EditorPlatform {
  if (runner.runtime.kind === 'wsl' || insideWsl()) return 'wsl'
  return process.platform === 'darwin' ? 'darwin' : 'linux'
}

/** The folder as Windows sees it, for a Windows editor opening a WSL worktree. */
async function windowsPath(runner: Runner, path: string): Promise<string | undefined> {
  if (runner.runtime.kind === 'wsl') return runner.toHostPath(path)
  if (!insideWsl()) return undefined
  const result = await runner.exec(['wslpath', '-w', path], { timeoutMs: 10_000 })
  return result.code === 0 ? result.stdout.trim() : undefined
}

/**
 * Starts the editor without waiting for it: some launchers (JetBrains' on Linux, or an IDE started from WSL)
 * run until the editor is closed. Its output goes nowhere, so an editor left running never writes to a closed
 * pipe. A launch that fails within the first few seconds is reported; one still running then is fine.
 */
function launch(runner: Runner, commandLine: string, settleMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = runner.spawn(runner.shell(`{ ${commandLine}; } </dev/null >/dev/null 2>&1`))
    const timer = setTimeout(() => {
      child.unref()
      resolve(0)
    }, settleMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(127)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 0)
    })
  })
}

export class Editors {
  constructor(private readonly db: Db) {}

  choice(): EditorChoice {
    return getSetting<EditorChoice>(this.db, 'editor', DEFAULT_EDITOR)
  }

  setChoice(choice: EditorChoice): EditorChoice {
    if (choice.id !== 'custom' && !EDITOR_PRESETS.some((preset) => preset.id === choice.id)) throw new Error(`Eregion doesn't know an editor called ${choice.id}`)
    const saved = choice.id === 'custom' ? { id: 'custom', command: choice.command?.trim() ?? '' } : { id: choice.id }
    setSetting(this.db, 'editor', saved)
    return saved
  }

  /** The editors Eregion knows, and which of them are on this machine. */
  async list(runner: Runner): Promise<EditorInfo[]> {
    const platform = platformOf(runner)
    return Promise.all(
      EDITOR_PRESETS.map(async (preset) => {
        const result = await runner.exec(runner.shell(editorCheck(preset, platform)), { timeoutMs: 20_000 })
        return { ...preset, found: result.code === 0 }
      })
    )
  }

  /** Opens a folder (a ticket's worktree) in the chosen editor. */
  async open(runner: Runner, path: string, settleMs = 3_000): Promise<void> {
    const choice = this.choice()
    const commandLine = editorCommand(choice, { path, windowsPath: await windowsPath(runner, path) }, platformOf(runner))
    const code = await launch(runner, commandLine, settleMs)
    if (code !== 0) {
      const why = code === 127 ? "it isn't installed, or its command isn't on the PATH" : `it isn't installed, or stopped straight away (exit code ${code})`
      throw new Error(`Couldn't open ${editorName(choice)}: ${why}. Choose your editor in Settings › Editor.`)
    }
  }
}
