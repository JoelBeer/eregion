import type { ChildProcess } from 'node:child_process'
import { posix } from 'node:path'
import type { Runtime } from '@shared/types'
import { collect, start } from './process'
import { posixKillTree, type ExecOptions, type ExecResult, type Runner } from './types'

/**
 * Builds the wsl.exe arguments for one command. Windows environment variables don't cross into WSL,
 * so per-command variables are passed through `env`.
 */
export function wslArgs(distro: string, argv: string[], options: ExecOptions = {}): string[] {
  const args = ['-d', distro]
  if (options.cwd) {
    args.push('--cd', options.cwd)
  }
  args.push('--')
  const env = Object.entries(options.env ?? {})
  if (env.length > 0) {
    args.push('env', ...env.map(([key, value]) => `${key}=${value}`))
  }
  return [...args, ...argv]
}

/** `/home/joel/site` in Ubuntu becomes `\\wsl.localhost\Ubuntu\home\joel\site`. */
export function wslToHostPath(distro: string, path: string): string {
  return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
}

/** Accepts both `\\wsl.localhost\` and the older `\\wsl$\` forms; other paths come back unchanged. */
export function hostToWslPath(distro: string, path: string): string {
  const match = path.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i)
  if (!match || match[1].toLowerCase() !== distro.toLowerCase()) {
    return path
  }
  return match[2].replace(/\\/g, '/') || '/'
}

/** `wsl.exe --list --quiet` prints UTF-16LE, one distro per line. */
export function parseDistroList(output: Buffer): string[] {
  return output
    .toString('utf16le')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Runs commands inside a WSL distro from a Windows host. */
export class WslRunner implements Runner {
  readonly runtime: Runtime

  constructor(readonly distro: string) {
    this.runtime = { kind: 'wsl', distro }
  }

  exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return collect('wsl.exe', wslArgs(this.distro, argv, options), { timeoutMs: options.timeoutMs, input: options.input })
  }

  spawn(argv: string[], options: ExecOptions = {}): ChildProcess {
    return start('wsl.exe', wslArgs(this.distro, argv, options))
  }

  shell(commandLine: string): string[] {
    return ['bash', '-lc', commandLine]
  }

  // File access goes through WSL itself rather than \\wsl.localhost, which is slow and unreliable from Windows.
  async readFile(path: string): Promise<string | null> {
    const result = await this.exec(['cat', '--', path])
    return result.code === 0 ? result.stdout : null
  }

  async writeFile(path: string, content: string): Promise<void> {
    const result = await this.exec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path], { input: content })
    if (result.code !== 0) throw new Error(`Couldn't write ${path}: ${result.stderr.trim()}`)
  }

  async exists(path: string): Promise<boolean> {
    return (await this.exec(['test', '-e', path])).code === 0
  }

  async copyFile(from: string, to: string): Promise<void> {
    const result = await this.exec(['sh', '-c', 'mkdir -p "$(dirname "$2")" && cp -- "$1" "$2"', 'sh', from, to])
    if (result.code !== 0) throw new Error(`Couldn't copy ${from}: ${result.stderr.trim()}`)
  }

  async killTree(pid: number): Promise<void> {
    await this.exec(['bash', '-c', posixKillTree(pid)])
  }

  join(...segments: string[]): string {
    return posix.join(...segments)
  }

  toHostPath(path: string): string {
    return wslToHostPath(this.distro, path)
  }

  fromHostPath(path: string): string {
    return hostToWslPath(this.distro, path)
  }
}
