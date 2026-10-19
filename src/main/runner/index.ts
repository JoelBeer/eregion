import { spawnSync } from 'node:child_process'
import type { Runtime } from '@shared/types'
import { NativeRunner } from './native'
import type { Runner } from './types'
import { WslRunner, parseDistroList } from './wsl'

export type { Runner } from './types'

export function runnerFor(runtime: Runtime): Runner {
  return runtime.kind === 'wsl' ? new WslRunner(runtime.distro) : new NativeRunner()
}

/** The runtimes available on this machine: the host itself, plus every WSL distro on Windows. */
export function availableRuntimes(platform: NodeJS.Platform = process.platform): Runtime[] {
  const runtimes: Runtime[] = [{ kind: 'native' }]
  if (platform !== 'win32') {
    return runtimes
  }
  const list = spawnSync('wsl.exe', ['--list', '--quiet'], { windowsHide: true })
  if (list.status === 0 && list.stdout) {
    for (const distro of parseDistroList(list.stdout)) {
      runtimes.push({ kind: 'wsl', distro })
    }
  }
  return runtimes
}

export function runtimeLabel(runtime: Runtime, platform: NodeJS.Platform = process.platform): string {
  if (runtime.kind === 'wsl') {
    return `WSL · ${runtime.distro}`
  }
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform as string] ?? platform
}
