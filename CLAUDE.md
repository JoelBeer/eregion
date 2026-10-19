# Eregion

A desktop app (Electron + React + TypeScript) that pulls Linear tickets and runs them through a configurable pipeline of AI agents (Claude Code, Cursor CLI), each ticket in its own git worktrees and environment.

The spec lives outside the repo: the design doc (main tab, Screen specs, Stage prompts) at https://claude.ai/code/artifact/8246795b-206a-419f-95de-e1fa04cbacdf, the screens canvas at https://claude.ai/artifact/Qv9ro17FQoMrhRFzBqs6NJ and the design system at https://claude.ai/artifact/4G6q5KWFx7XnjbrH2q3WoR. Build progress and decisions: `docs/build-plan.md`.

## Layout

- `src/main`: the Electron main process. Owns every process, git, the database and integrations.
  - `runner/`: `NativeRunner` and `WslRunner`. Every command goes through the runner of the repo it belongs to; never call `child_process` elsewhere.
  - `db/`: SQLite (better-sqlite3). Schema changes are new entries in `db/schema.ts` migrations, never edits to old ones.
- `src/preload`: exposes the typed `EregionApi` (`src/shared/types.ts`) as `window.eregion`. The renderer has no Node access.
- `src/renderer`: React UI. Styles come from the design system: `tokens.css` (generated from its tokens.json) and `ds.css` (its component classes, `er-*`).
- `src/shared`: types and pure logic used by both sides.

## Commands

- `npm run dev`: start the app with hot reload.
- `npm test`: unit and integration tests (Vitest, plain Node).
- `npm run typecheck`, `npm run build`.

## Conventions

- Copy in the UI follows the design doc: plain, specific, sentence case, no jargon.
- Anything shown as a tag or status must come from real data or a rule written in the Screen specs tab.
- Tests sit next to the code as `*.test.ts`. External tools (git, gh, agents, Linear) are faked in unit tests; integration tests use temporary git repos.
