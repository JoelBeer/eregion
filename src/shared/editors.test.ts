import { describe, expect, it } from 'vitest'
import { EDITOR_PRESETS, editorCheck, editorCommand, editorName } from './editors'

describe('editorCommand', () => {
  it("runs a preset's launcher with the folder", () => {
    expect(editorCommand({ id: 'phpstorm' }, { path: '/home/joel/.eregion/wm/WM-1/word-magic' }, 'linux')).toBe("phpstorm '/home/joel/.eregion/wm/WM-1/word-magic'")
  })

  it("uses the launcher on macOS, else the command inside the app, else open", () => {
    const vscode = editorCommand({ id: 'vscode' }, { path: '/Users/joel/wm' }, 'darwin', [{ path: '/Users/joel/wm/app/a.php' }])
    expect(vscode).toContain("if command -v code >/dev/null 2>&1; then code '/Users/joel/wm' '/Users/joel/wm/app/a.php'")
    expect(vscode).toContain(`[ -x "$d/"'Visual Studio Code.app/Contents/Resources/app/bin/code' ]`)
    expect(vscode).toContain("else open -a 'Visual Studio Code' '/Users/joel/wm' '/Users/joel/wm/app/a.php'; fi")
  })

  it('opens a JetBrains IDE on macOS with its own arguments, so the files land in the project', () => {
    expect(editorCommand({ id: 'phpstorm' }, { path: '/Users/joel/wm' }, 'darwin', [{ path: '/Users/joel/wm/app/a.php' }])).toBe(
      "if command -v phpstorm >/dev/null 2>&1; then phpstorm '/Users/joel/wm' '/Users/joel/wm/app/a.php'; else open -na 'PhpStorm' --args '/Users/joel/wm' '/Users/joel/wm/app/a.php'; fi"
    )
  })

  it('puts files where a custom command says, or at the end', () => {
    expect(editorCommand({ id: 'custom', command: 'idea {{path}} {{files}} --wait' }, { path: '/w' }, 'linux', [{ path: '/w/a' }, { path: '/w/b c' }])).toBe("idea '/w' '/w/a' '/w/b c' --wait")
    expect(editorCommand({ id: 'custom', command: 'kate' }, { path: '/w' }, 'linux', [{ path: '/w/a' }])).toBe("kate '/w' '/w/a'")
  })

  it('puts the folder where a custom command says, as Linux or Windows sees it', () => {
    expect(editorCommand({ id: 'custom', command: 'idea {{path}} --wait' }, { path: '/w/app' }, 'linux')).toBe("idea '/w/app' --wait")
    expect(editorCommand({ id: 'custom', command: '"/mnt/c/PhpStorm/bin/phpstorm64.exe" {{ windowsPath }}' }, { path: '/w/app', windowsPath: '\\\\wsl.localhost\\Ubuntu\\w\\app' }, 'linux')).toBe(
      `"/mnt/c/PhpStorm/bin/phpstorm64.exe" '\\\\wsl.localhost\\Ubuntu\\w\\app'`
    )
  })

  it('adds the folder at the end of a custom command that names neither, quoting it safely', () => {
    expect(editorCommand({ id: 'custom', command: 'kate' }, { path: "/w/it's" }, 'linux')).toBe(`kate '/w/it'\\''s'`)
  })

  it('asks for a command when the custom one is empty', () => {
    expect(() => editorCommand({ id: 'custom', command: ' ' }, { path: '/w' }, 'linux')).toThrow('Set the command for your editor in Settings › Editor')
  })
})

describe('inside WSL', () => {
  it('uses the newest Windows install, with the folder as Windows sees it', () => {
    const command = editorCommand({ id: 'phpstorm' }, { path: '/home/joel/wm', windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\joel\\wm' }, 'wsl')
    expect(command).toContain(`for f in '/mnt/c/''Program Files/JetBrains/PhpStorm'*'/bin/phpstorm64.exe'`)
    expect(command).toContain(`then "$e" '\\\\wsl.localhost\\Ubuntu\\home\\joel\\wm'; else phpstorm '/home/joel/wm'; fi`)
  })

  it('gives a Windows IDE the files as Windows sees them too', () => {
    const command = editorCommand({ id: 'phpstorm' }, { path: '/w', windowsPath: 'W:\\w' }, 'wsl', [{ path: '/w/a.php', windowsPath: 'W:\\w\\a.php' }])
    expect(command).toContain(`then "$e" 'W:\\w' 'W:\\w\\a.php'; else phpstorm '/w' '/w/a.php'; fi`)
  })

  it("gives VS Code's Windows launcher the Linux path, which it opens through WSL", () => {
    expect(editorCommand({ id: 'vscode' }, { path: '/home/joel/wm', windowsPath: 'W' }, 'wsl')).toContain(`then "$e" '/home/joel/wm'`)
  })
})

describe('editorCheck and editorName', () => {
  const phpstorm = EDITOR_PRESETS.find((preset) => preset.id === 'phpstorm')!

  it('looks for the launcher, and on macOS for the app in either Applications folder', () => {
    expect(editorCheck(phpstorm, 'linux')).toBe('command -v phpstorm >/dev/null 2>&1')
    expect(editorCheck(phpstorm, 'darwin')).toBe(`command -v phpstorm >/dev/null 2>&1 || test -d /Applications/'PhpStorm.app' || test -d "$HOME/Applications/"'PhpStorm.app'`)
  })

  it('names the chosen editor', () => {
    expect(editorName({ id: 'phpstorm' })).toBe('PhpStorm')
    expect(editorName({ id: 'custom', command: 'kate' })).toBe('your editor')
  })
})
