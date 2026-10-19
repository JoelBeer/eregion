import type { ChildProcess } from 'node:child_process'
import type { Runtime } from '@shared/types'
import { collect, start } from './process'
import type { ExecOptions, ExecResult, Runner } from './types'

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
    return collect('wsl.exe', wslArgs(this.distro, argv, options), { timeoutMs: options.timeoutMs })
  }

  spawn(argv: string[], options: ExecOptions = {}): ChildProcess {
    return start('wsl.exe', wslArgs(this.distro, argv, options))
  }

  shell(commandLine: string): string[] {
    return ['bash', '-lc', commandLine]
  }

  toHostPath(path: string): string {
    return wslToHostPath(this.distro, path)
  }

  fromHostPath(path: string): string {
    return hostToWslPath(this.distro, path)
  }
}
