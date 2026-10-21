/**
 * The code editor "View code in editor" opens a ticket's worktree in: one of the common ones, or a command of
 * your own. Settings › Editor chooses it, for every project on this machine.
 */

export interface EditorPreset {
  id: string
  name: string
  /** Its command-line launcher, where it has one. */
  command: string
  /** The app's name on macOS, opened with `open -a`, so its launcher needn't be installed. */
  macApp?: string
  /**
   * Where it's installed on Windows, for Eregion running inside WSL: paths under C:\ (with * for a version),
   * and whether it takes the folder as Windows sees it (\\wsl.localhost\...) or as Linux does.
   */
  windows?: { paths: string[]; takes: 'windows' | 'linux' }
}

const jetbrains = (name: string, exe: string): EditorPreset['windows'] => ({
  paths: [`Program Files/JetBrains/${name}*/bin/${exe}`, `Users/*/AppData/Local/Programs/${name}*/bin/${exe}`, `Users/*/AppData/Local/JetBrains/Toolbox/apps/${name}/*/bin/${exe}`],
  takes: 'windows'
})

export const EDITOR_PRESETS: EditorPreset[] = [
  { id: 'vscode', name: 'VS Code', command: 'code', macApp: 'Visual Studio Code', windows: { paths: ['Users/*/AppData/Local/Programs/Microsoft VS Code/bin/code', 'Program Files/Microsoft VS Code/bin/code'], takes: 'linux' } },
  { id: 'cursor', name: 'Cursor', command: 'cursor', macApp: 'Cursor', windows: { paths: ['Users/*/AppData/Local/Programs/cursor/resources/app/bin/cursor'], takes: 'linux' } },
  { id: 'phpstorm', name: 'PhpStorm', command: 'phpstorm', macApp: 'PhpStorm', windows: jetbrains('PhpStorm', 'phpstorm64.exe') },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm', macApp: 'WebStorm', windows: jetbrains('WebStorm', 'webstorm64.exe') },
  { id: 'zed', name: 'Zed', command: 'zed', macApp: 'Zed' },
  { id: 'sublime', name: 'Sublime Text', command: 'subl', macApp: 'Sublime Text', windows: { paths: ['Program Files/Sublime Text/subl.exe'], takes: 'windows' } },
  { id: 'atom', name: 'Atom', command: 'atom', macApp: 'Atom' }
]

/** A preset by id, or `custom` with a command line of your own. */
export interface EditorChoice {
  id: string
  /** For `custom`: the command, with {{path}} (or {{windowsPath}}, inside WSL) where the folder goes. */
  command?: string
}

export const DEFAULT_EDITOR: EditorChoice = { id: 'vscode' }

/** An editor as Settings lists it: whether it's on this machine. */
export interface EditorInfo extends EditorPreset {
  found: boolean
}

/** Where the editor runs from: macOS, Linux, or Linux inside WSL (where Windows editors can open WSL folders). */
export type EditorPlatform = 'darwin' | 'linux' | 'wsl'

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

/**
 * The shell command that opens a folder in the chosen editor. On macOS a preset opens its app with `open -a`;
 * inside WSL a preset installed on Windows is used, or else its launcher in Linux; elsewhere its launcher. A
 * custom command gets the folder where {{path}} or {{windowsPath}} is, or at the end when it names neither.
 */
export function editorCommand(choice: EditorChoice, folder: { path: string; windowsPath?: string }, platform: EditorPlatform): string {
  if (choice.id === 'custom') {
    const template = choice.command?.trim()
    if (!template) throw new Error('Set the command for your editor in Settings › Editor')
    if (!/\{\{\s*(path|windowsPath)\s*\}\}/.test(template)) return `${template} ${shellQuote(folder.path)}`
    return template.replace(/\{\{\s*(path|windowsPath)\s*\}\}/g, (_match, name: string) => shellQuote(name === 'windowsPath' ? (folder.windowsPath ?? folder.path) : folder.path))
  }
  const preset = EDITOR_PRESETS.find((item) => item.id === choice.id) ?? EDITOR_PRESETS[0]
  const launcher = `${preset.command} ${shellQuote(folder.path)}`
  if (platform === 'darwin' && preset.macApp) return `open -a ${shellQuote(preset.macApp)} ${shellQuote(folder.path)}`
  if (platform === 'wsl' && preset.windows) {
    const target = preset.windows.takes === 'windows' ? (folder.windowsPath ?? folder.path) : folder.path
    return `${findOnWindows(preset.windows)}; if [ -n "$e" ]; then "$e" ${shellQuote(target)}; else ${launcher}; fi`
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
