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
 * The Windows command that opens a URL in the default browser. Windows' own URL handler takes the
 * URL as one argument with no shell in between, so `&`, `?` and `=` survive. (explorer.exe doesn't
 * read a long query-string URL as a link and opens Documents instead.)
 */
export function windowsOpenCommand(url: string): [string, string[]] {
  return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
}

/** Opens a web link in the person's browser. Inside WSL that's the Windows default browser. */
export async function openUrl(url: string, fallback: (url: string) => Promise<void>): Promise<void> {
  if (!/^https?:\/\//.test(url)) return
  if (insideWsl()) {
    const [command, args] = windowsOpenCommand(url)
    if (await run(command, args)) return
  }
  await fallback(url)
}
