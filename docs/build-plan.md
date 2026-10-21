# Eregion build plan

Source of truth for the design: the design doc (main tab, Screen specs, Stage prompts) at
https://claude.ai/code/artifact/8246795b-206a-419f-95de-e1fa04cbacdf, the screens canvas at
https://claude.ai/artifact/Qv9ro17FQoMrhRFzBqs6NJ and the design system at
https://claude.ai/artifact/4G6q5KWFx7XnjbrH2q3WoR.

## Decisions made while building

- Development and first use run inside WSL Ubuntu, with the window shown on Windows through WSLg. All tools (git, gh, Claude Code, PHP) live in WSL. A native Windows build reaching WSL through `wsl.exe` stays supported in code (`WslRunner`).
- Plan runs as a conversation in the session panel over Claude Code's stream-json, like every other stage. No embedded terminal, so no node-pty.
- One local commit per working, tested phase on `main`. Nothing is pushed.
- A web preview (`npm run preview:web`) serves the built UI and the real API over HTTP from plain Node, so screens can be checked in a browser without Electron.
- Agent runs use the CLIs headless (`claude -p --input-format stream-json --output-format stream-json --verbose`), checked against Claude Code 2.1.303. Cost is the last result's running `total_cost_usd`; tokens are summed per turn. The Cursor adapter follows Cursor's documented stream-json format but is unverified until the Cursor CLI is installed.
- Costs come from what Claude Code reports (`total_cost_usd`); Cursor runs record tokens only.
- Linear is reached with plain GraphQL over fetch (no @linear/sdk): a dozen queries, easy to fake in tests. Sign-in is the user's own private OAuth app with PKCE and a loopback redirect on 127.0.0.1:47321 to 47323; a client secret is optional, for apps that insist. Tokens are encrypted with Electron's safeStorage.
- GitHub goes through gh in each repo's runtime. PR bodies are updated through the REST API (`gh pr edit` breaks on classic projects in gh 2.63), drafts are marked ready through GraphQL, and failed job logs come from the REST job-logs endpoint (`gh run view --log-failed` prints nothing for some runs on gh 2.63).
- Inside WSL, links open in the Windows browser through wslview or explorer.exe.
- Watch CI polls every 15 seconds and checks each ticket at its stage's interval. A ticket watching CI is `idle` in the `ci` stage, so a restart doesn't stop it.
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
- [x] 2. Projects and recipes (steps 5 to 7 of setup arrive with phases 3, 5 and 6)
- [x] 3. Ticket workspaces
- [x] 4. Agents
- [x] 5. Pipeline and board
- [x] 6. Integrations (proven end to end on Word Magic: WM-1 went from Linear through PR #2 to merged and Done)
- [x] 7. Crew, Forge, Costs, Settings, voice (left for later: per-stage skill modes such as "always run" and "ask me first", allowing single tools of an MCP server, and MCP choices for Cursor runs)
- [x] 8. Polish and run instructions (the window, icon and launcher; pipeline history; README and MIT licence. Still to do: make the repo public, and installers)

## Polish list (phase 8)

- Window: open full screen (maximised); remove the File / Edit / View menu bar; one clean title bar with the Eregion name and the window controls on the same row (frameless window with our own drag region, or a hidden title bar with overlay controls). Done: frameless with our own title bar. Inside WSL, `npm start` runs Electron as a Wayland client (`scripts/electron-flags.mjs`), because under X11 WSLg can't drag or minimise a frameless window.
- App icon: the anvil mark from the design system, for the window, the taskbar and the WSLg launcher, instead of the default Electron / Linux penguin icon. Done: the window and title bar; the taskbar needs the launcher installed (see V1 fixes).
- Pipeline versions: restore an older pipeline version (saved as a new version), or pull a single stage's settings from an older version, with a diff of what changes.
- README (including the Linear app steps), licence, run instructions; then make JoelBeer/eregion public.
- Packaging: leave onnxruntime-node (about 550 MB, pulled in by transformers.js) out of installers; dictation uses the WebAssembly runtime bundled in the renderer.

## V1 fixes (from using it)

Places where V1 didn't match its own design. New features are in the design doc's V2 tab.

- [x] Board tiles open the ticket from a click anywhere on the tile, not just the title (the title link stretches over the card; the PR and Open app links keep their own action).
- [x] Taskbar icon: WSLg only reads app entries from the system folders (`/usr/share/applications`, `/usr/local/share/applications`), and matches them to the window's app id (`eregion`). `npm run install-launcher` now installs the entry and icons into `/usr/local/share` inside WSL (it asks for your password), so the taskbar shows the anvil instead of the penguin.
- [x] Voice: a status line shows listening (level meter and timer) and then transcribing (spinner and timer), so it never looks as if nothing happened. A downloaded model loads in the background and dictation can start while it loads; the words wait for it. The Small model takes about 13 s for a 2 s clip on this machine; Base is quicker.
- [x] Pipeline editor matches the screens canvas: stage cards with a drag handle, a + between stages to insert one there, Add stage at the end (before Watch CI), the Watch CI switch on its card, and a dashed outline on the drop target.
- [x] Costs: 25 tickets at a time, more as you scroll, with a search by key or title; a ticket's runs open under its row. The totals always cover the whole period.
- [x] The window could stop appearing inside WSL: it was created hidden and shown on ready-to-show, but under Wayland a window that was never shown gets no frames, so a heavy page may never paint and the window never appeared (the first launch after a WSL restart often still worked, which made it look like WSLg was stuck). It is now shown at once, with the blue background until the page draws. (X11 is no way out: WSLg puts an invisible title strip of its own over the top of a frameless window there, which takes every click on our title bar.)
- [x] One Eregion at a time: opening it again from the Start menu or taskbar brings the open window back instead of starting a second copy on the same database.
- [x] Commands run with the user's own terminal environment. At startup Eregion reads the login shell's environment once (`$SHELL -ilc`, so ~/.zshrc counts too: nvm, Herd, Homebrew), and every command and agent starts from it. What only Eregion needs stays out: `NODE_ENV=production` (it made `yarn install` skip devDependencies, so a worktree had no turbo), npm's `npm_*` variables (nvm won't load while `npm_config_prefix` is set) and the `node_modules/.bin` folders `npm run` puts on PATH.
