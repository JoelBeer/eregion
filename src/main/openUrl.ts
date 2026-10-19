import { spawn } from 'node:child_process'

/** True inside WSL, where links should open in the Windows browser rather than a Linux one. */
export function insideWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
}

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/**
 * Opens a web link in the person's browser. Inside WSL that's the Windows default browser, through
 * wslview when it's installed, or explorer.exe otherwise.
 */
export async function openUrl(url: string, fallback: (url: string) => Promise<void>): Promise<void> {
  if (!/^https?:\/\//.test(url)) return
  if (insideWsl()) {
    if (await run('wslview', [url])) return
    if (await run('explorer.exe', [url])) return
  }
  await fallback(url)
}
