import { describe, expect, it } from 'vitest'
import { insideWsl, windowsOpenCommand } from './openUrl'

describe('openUrl', () => {
  it("hands the whole URL to Windows' URL handler as one argument", () => {
    const url = 'https://linear.app/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A47321%2Foauth%2Fcallback&scope=read%2Cwrite'
    expect(windowsOpenCommand(url)).toEqual(['rundll32.exe', ['url.dll,FileProtocolHandler', url]])
  })

  it('knows when it runs inside WSL', () => {
    expect(insideWsl({ WSL_DISTRO_NAME: 'Ubuntu' })).toBe(process.platform === 'linux')
    expect(insideWsl({})).toBe(false)
  })
})
