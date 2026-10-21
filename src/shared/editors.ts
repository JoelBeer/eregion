/**
 * The code editor "View code in editor" opens a ticket's worktree in: one of the common ones, or a command of
 * your own. Settings › Editor chooses it, for every project on this machine. Along with the folder it can open
 * files in it, such as the ones the ticket changed.
 */

export interface EditorPreset {
  id: string
  name: string
  /** Its command-line launcher, where it has one. */
  command: string
  /** The app's name on macOS. */
  macApp?: string
  /**
   * How it opens on macOS when its launcher isn't on the PATH: the command inside the app bundle (which takes
   * a folder and files like the launcher), `jetbrains` for `open -na App --args …`, or plain `open -a`.
   */
  macOpen?: { cli: string } | 'jetbrains'
  /**
   * Where it's installed on Windows, for Eregion running inside WSL: paths under C:\ (with * for a version),
   * and whether it takes paths as Windows sees them (\\wsl.localhost\...) or as Linux does.
   */
  windows?: { paths: string[]; takes: 'windows' | 'linux' }
}

const jetbrains = (name: string, exe: string): EditorPreset['windows'] => ({
  paths: [`Program Files/JetBrains/${name}*/bin/${exe}`, `Users/*/AppData/Local/Programs/${name}*/bin/${exe}`, `Users/*/AppData/Local/JetBrains/Toolbox/apps/${name}/*/bin/${exe}`],
  takes: 'windows'
})

export const EDITOR_PRESETS: EditorPreset[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    command: 'code',
    macApp: 'Visual Studio Code',
    macOpen: { cli: 'Contents/Resources/app/bin/code' },
    windows: { paths: ['Users/*/AppData/Local/Programs/Microsoft VS Code/bin/code', 'Program Files/Microsoft VS Code/bin/code'], takes: 'linux' }
  },
  { id: 'cursor', name: 'Cursor', command: 'cursor', macApp: 'Cursor', macOpen: { cli: 'Contents/Resources/app/bin/cursor' }, windows: { paths: ['Users/*/AppData/Local/Programs/cursor/resources/app/bin/cursor'], takes: 'linux' } },
  { id: 'phpstorm', name: 'PhpStorm', command: 'phpstorm', macApp: 'PhpStorm', macOpen: 'jetbrains', windows: jetbrains('PhpStorm', 'phpstorm64.exe') },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm', macApp: 'WebStorm', macOpen: 'jetbrains', windows: jetbrains('WebStorm', 'webstorm64.exe') },
  { id: 'zed', name: 'Zed', command: 'zed', macApp: 'Zed', macOpen: { cli: 'Contents/MacOS/cli' } },
  { id: 'sublime', name: 'Sublime Text', command: 'subl', macApp: 'Sublime Text', macOpen: { cli: 'Contents/SharedSupport/bin/subl' }, windows: { paths: ['Program Files/Sublime Text/subl.exe'], takes: 'windows' } },
  { id: 'atom', name: 'Atom', command: 'atom', macApp: 'Atom' }
]

/** At most this many files open at once, so a big change doesn't open a hundred tabs. */
export const MAX_EDITOR_FILES = 20

/** What opened: how many files, out of how many asked for. */
export interface OpenedInEditor {
  opened: number
  total: number
}

/** A preset by id, or `custom` with a command line of your own. */
export interface EditorChoice {
  id: string
  /**
   * For `custom`: the command, with {{path}} (or {{windowsPath}}, inside WSL) where the folder goes, and
   * {{files}} where the files go (at the end when it's left out).
   */
  command?: string
}

export const DEFAULT_EDITOR: EditorChoice = { id: 'vscode' }

/** An editor as Settings lists it: whether it's on this machine. */
export interface EditorInfo extends EditorPreset {
  found: boolean
}

/** Where the editor runs from: macOS, Linux, or Linux inside WSL (where Windows editors can open WSL folders). */
export type EditorPlatform = 'darwin' | 'linux' | 'wsl'

/** A folder or file, as Linux or macOS sees it, and as Windows does when Eregion runs inside WSL. */
export interface EditorPath {
  path: string
  windowsPath?: string
}

export function editorName(choice: EditorChoice): string {
  if (choice.id === 'custom') return 'your editor'
  return EDITOR_PRESETS.find((preset) => preset.id === choice.id)?.name ?? 'your editor'
}

/** Single-quoted for a POSIX shell. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** A path under C:\ as a bash glob from WSL: the fixed parts quoted, each * left to expand. */
function windowsGlob(path: string): string {
  return path
    .split('*')
    .map((part) => (part ? shellQuote(part) : ''))
    .join('*')
    .replace(/^/, "'/mnt/c/'")
}

/** Sets $e to the newest Windows install of a preset that exists, or leaves it empty. */
function findOnWindows(windows: NonNullable<EditorPreset['windows']>): string {
  return `e=; for f in ${windows.paths.map(windowsGlob).join(' ')}; do [ -e "$f" ] && e="$f"; done`
}

/** Sets $a to the command inside the app bundle, in either Applications folder, or leaves it empty. */
function findInMacApp(app: string, cli: string): string {
  return `a=; for d in /Applications "$HOME/Applications"; do [ -x "$d/"${shellQuote(`${app}.app/${cli}`)} ] && a="$d/"${shellQuote(`${app}.app/${cli}`)}; done`
}

const quoted = (paths: string[]): string => paths.map(shellQuote).join(' ')

/**
 * The shell command that opens a folder, and files in it, in the chosen editor. On macOS a preset uses its
 * launcher, or the command inside its app, or `open`; inside WSL a preset installed on Windows is used, or
 * else its launcher in Linux; elsewhere its launcher. A custom command gets the folder where {{path}} or
 * {{windowsPath}} is (at the end when it names neither), and the files where {{files}} is (else at the end).
 */
export function editorCommand(choice: EditorChoice, folder: EditorPath, platform: EditorPlatform, files: EditorPath[] = []): string {
  const linux = [folder.path, ...files.map((file) => file.path)]
  if (choice.id === 'custom') {
    const template = choice.command?.trim()
    if (!template) throw new Error('Set the command for your editor in Settings › Editor')
    const windows = /\{\{\s*windowsPath\s*\}\}/.test(template)
    const fileList = quoted(files.map((file) => (windows ? (file.windowsPath ?? file.path) : file.path)))
    let command = /\{\{\s*(path|windowsPath)\s*\}\}/.test(template)
      ? template.replace(/\{\{\s*(path|windowsPath)\s*\}\}/g, (_match, name: string) => shellQuote(name === 'windowsPath' ? (folder.windowsPath ?? folder.path) : folder.path))
      : `${template} ${shellQuote(folder.path)}`
    if (/\{\{\s*files\s*\}\}/.test(command)) command = command.replace(/\{\{\s*files\s*\}\}/g, fileList)
    else if (fileList) command = `${command} ${fileList}`
    return command.trim()
  }
  const preset = EDITOR_PRESETS.find((item) => item.id === choice.id) ?? EDITOR_PRESETS[0]
  const launcher = `${preset.command} ${quoted(linux)}`
  if (platform === 'darwin' && preset.macApp) {
    const app = shellQuote(preset.macApp)
    const fallback = preset.macOpen === 'jetbrains' ? `open -na ${app} --args ${quoted(linux)}` : `open -a ${app} ${quoted(linux)}`
    const bundled = typeof preset.macOpen === 'object' ? `${findInMacApp(preset.macApp, preset.macOpen.cli)}; if [ -n "$a" ]; then "$a" ${quoted(linux)}; else ${fallback}; fi` : fallback
    return `if command -v ${preset.command} >/dev/null 2>&1; then ${launcher}; else ${bundled}; fi`
  }
  if (platform === 'wsl' && preset.windows) {
    const targets = preset.windows.takes === 'windows' ? [folder, ...files].map((item) => item.windowsPath ?? item.path) : linux
    return `${findOnWindows(preset.windows)}; if [ -n "$e" ]; then "$e" ${quoted(targets)}; else ${launcher}; fi`
  }
  return launcher
}

/** Checks whether a preset is on this machine: its launcher on PATH, its macOS app, or its Windows install from WSL. */
export function editorCheck(preset: EditorPreset, platform: EditorPlatform): string {
  const launcher = `command -v ${preset.command} >/dev/null 2>&1`
  if (platform === 'darwin' && preset.macApp) {
    const app = shellQuote(`${preset.macApp}.app`)
    return `${launcher} || test -d /Applications/${app} || test -d "$HOME/Applications/"${app}`
  }
  if (platform === 'wsl' && preset.windows) return `${launcher} || { ${findOnWindows(preset.windows)}; [ -n "$e" ]; }`
  return launcher
}
