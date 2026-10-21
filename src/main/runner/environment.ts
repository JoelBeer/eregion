import { collect } from './process'

/** Describe the shell that printed them, not the environment a command should start with. */
const SHELL_ONLY = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
const MARKER = '__EREGION_ENV__'

let loginEnvironment: NodeJS.ProcessEnv = {}

/**
 * Set for Eregion itself, not for the repos it works on: NODE_ENV=production from electron-vite, and when it
 * was started with `npm run`, npm's own variables (nvm won't load while npm_config_prefix is set).
 */
function isAppOnly(key: string): boolean {
  return key === 'NODE_ENV' || key === 'INIT_CWD' || key.startsWith('npm_')
}

/** The folders `npm run` puts on PATH: Eregion's own node_modules/.bin and npm's node-gyp shim. */
function isAppOnlyPathEntry(entry: string): boolean {
  return /[\\/]node_modules[\\/]\.bin$/.test(entry) || /[\\/]node-gyp-bin$/.test(entry)
}

export function withoutAppOnly(env: NodeJS.ProcessEnv, delimiter = process.platform === 'win32' ? ';' : ':'): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (isAppOnly(key)) continue
    copy[key] = /^path$/i.test(key) && value !== undefined ? value.split(delimiter).filter((entry) => !isAppOnlyPathEntry(entry)).join(delimiter) : value
  }
  return copy
}

/** Reads `env -0` output printed between two markers, ignoring anything the shell's startup files print around it. */
export function parseEnvironment(output: string, marker: string = MARKER): NodeJS.ProcessEnv {
  const start = output.indexOf(marker)
  const end = output.lastIndexOf(marker)
  if (start === -1 || end <= start) return {}
  const env: NodeJS.ProcessEnv = {}
  for (const entry of output.slice(start + marker.length, end).split('\0')) {
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    const key = entry.slice(0, equals)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !SHELL_ONLY.has(key)) env[key] = entry.slice(equals + 1)
  }
  return env
}

/**
 * The environment the user's own terminal has: their login shell, started interactive so it reads every
 * startup file (on macOS, PATH for nvm, Herd or Homebrew often lives in ~/.zshrc). Empty if it can't be read
 * in time. The timeout doesn't wait for the shell to finish: something a startup file leaves running in the
 * background (an agent, a sleep) keeps the shell's output open, and Eregion waits on this before its window opens.
 */
export async function readLoginEnvironment(shell: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 5_000): Promise<NodeJS.ProcessEnv> {
  let timer: NodeJS.Timeout | undefined
  const tooSlow = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))
  const result = await Promise.race([collect(shell, ['-ilc', `printf '${MARKER}'; env -0; printf '${MARKER}'`], { env: withoutAppOnly(env), timeoutMs }), tooSlow])
  clearTimeout(timer)
  return result?.code === 0 ? parseEnvironment(result.stdout) : {}
}

/** The shell to read when $SHELL isn't set: zsh is the Mac's default, bash everywhere else. */
export function defaultShell(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/** Reads the login shell's environment once, at startup, for every command the native runner starts. */
export async function useLoginEnvironment(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return
  loginEnvironment = await readLoginEnvironment(process.env.SHELL || defaultShell(platform))
}

/** What a command starts with: Eregion's environment, the user's login shell on top, then the command's own variables. */
export function commandEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...withoutAppOnly(process.env), ...loginEnvironment, ...extra }
}
