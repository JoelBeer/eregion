/** Where a repo's commands run: on the host directly, or inside a WSL distro from a Windows host. */
export type Runtime = { kind: 'native' } | { kind: 'wsl'; distro: string }

/** One external tool Eregion depends on, as found in one runtime. */
export interface ToolCheck {
  /** git, gh, or an agent's command (claude, cursor-agent, codex, or a custom agent's). */
  tool: string
  runtime: string
  found: boolean
  version?: string
  /** Extra state worth showing, e.g. whether gh is signed in. */
  detail?: string
}

export interface AppInfo {
  version: string
  platform: string
  databasePath: string
}

