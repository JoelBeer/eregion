import { describe, expect, it } from 'vitest'
import { EDITOR_PRESETS, editorCheck, editorCommand, editorName } from './editors'

describe('editorCommand', () => {
  it("runs a preset's launcher with the folder", () => {
    expect(editorCommand({ id: 'phpstorm' }, { path: '/home/joel/.eregion/wm/WM-1/word-magic' }, 'linux')).toBe("phpstorm '/home/joel/.eregion/wm/WM-1/word-magic'")
  })

  it("opens the preset's app on macOS, so its launcher needn't be installed", () => {
    expect(editorCommand({ id: 'vscode' }, { path: '/Users/joel/wm' }, 'darwin')).toBe("open -a 'Visual Studio Code' '/Users/joel/wm'")
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
