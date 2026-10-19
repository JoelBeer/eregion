# Eregion build plan

Source of truth for the design: the design doc (main tab, Screen specs, Stage prompts) at
https://claude.ai/code/artifact/8246795b-206a-419f-95de-e1fa04cbacdf, the screens canvas at
https://claude.ai/artifact/Qv9ro17FQoMrhRFzBqs6NJ and the design system at
https://claude.ai/artifact/4G6q5KWFx7XnjbrH2q3WoR.

## Decisions made while building

- Development and first use run inside WSL Ubuntu, with the window shown on Windows through WSLg. All tools (git, gh, Claude Code, PHP) live in WSL. A native Windows build reaching WSL through `wsl.exe` stays supported in code (`WslRunner`).
- Plan runs as a conversation in the session panel over Claude Code's stream-json, like every other stage. No embedded terminal, so no node-pty.
- One local commit per working, tested phase on `main`. Nothing is pushed.
- Costs come from what Claude Code reports (`total_cost_usd`); Cursor runs record tokens only.
- Native modules: better-sqlite3 only. Version 13 ships N-API prebuilds for every platform, so the same binary runs in Node (tests) and Electron, with no rebuild and no C++ build tools.

## Phases

1. Foundation: Electron + React shell, SQLite schema and data access, native and WSL runners, tool checks, First run screen.
2. Projects and recipes: projects, repos, variables, setup steps, services, teardown; the project setup screens; Projects index; import and export.
3. Ticket workspaces: slots, worktrees, the plan checkout, services, teardown.
4. Agents: Claude Code and Cursor adapters, prompt templates, messages (send now and queue), the session panel.
5. Pipeline and board: stages, output checks, review loops, stop states, Eregion's commits and pushes, Board and Ticket screens.
6. Integrations: Linear (own-app OAuth with PKCE, or API key; import, plan comment, status), GitHub through gh (push, PRs, checks, merges), PR stage, Watch CI.
7. Crew, Forge, Costs, Settings (skills, MCP, rules, integrations, agents, voice) and voice dictation.
8. Polish, README and run instructions.

## Progress

- [x] 1. Foundation
- [ ] 2. Projects and recipes
- [ ] 3. Ticket workspaces
- [ ] 4. Agents
- [ ] 5. Pipeline and board
- [ ] 6. Integrations
- [ ] 7. Crew, Forge, Costs, Settings, voice
- [ ] 8. Polish and run instructions
