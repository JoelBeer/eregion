<p align="center"><img src="build/icons/128x128.png" width="96" alt="" /></p>

# Eregion

Eregion is a desktop app that takes Linear tickets through a pipeline of AI coding agents. Each ticket gets its own git worktrees, database, ports and running app, and moves across a board: **Plan → Build → Review → PR → Watch CI**.

- **Plan** with an agent in a conversation; the plan is written to a fixed template, and approval waits until every open question is answered.
- **Build** happens in the ticket's own worktree, with the app's services running. Eregion commits and pushes; the agent never touches git.
- **Review** is a second agent, then you. A failed review goes back to Build with the issues to fix.
- **PR** opens one pull request per changed repo, as drafts if you like, linked to each other and to the Linear issue.
- **Watch CI** re-runs a failed check once, then has an agent fix it, push, and watch again. When everything merges, the environment is torn down and the ticket is done.

Around that: the **Forge** for quick read-only chats, **Costs** from what each run reports, a **Crew** of named agents, per-run **skills and MCP servers**, editable **AI rules**, and **voice dictation** with Whisper running on your own machine.

Eregion runs the agent CLIs you already use (**Claude Code**, or the **Cursor CLI**) and **gh**, signed in as you. It holds no shared credentials and sends nothing anywhere except to Linear, GitHub and the agents you choose.

## What you need

| | |
| --- | --- |
| **OS** | Windows 11 with **WSL2** (Eregion runs inside WSL and shows its window on Windows through WSLg), or Linux. macOS should work but hasn't been tried yet |
| **Node.js** | 22 or later, with npm |
| **git** | any recent version |
| **GitHub CLI** | `gh`, signed in with `gh auth login` |
| **An agent CLI** | [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`, signed in), and/or the Cursor CLI (`cursor-agent`) |
| **Linear** | optional; your own private OAuth app or a personal API key (see below) |

Eregion never installs, updates or signs in to these tools. Settings › Agents shows what it found and can send a tiny test prompt.

## Run it on Windows (WSL)

Everything runs inside your WSL distribution (Ubuntu here), where your repos and tools live; the window appears on Windows.

1. **In Ubuntu**, install the libraries Electron needs (once):

   ```bash
   sudo apt install -y libnss3 libnspr4
   ```

2. **Clone and install:**

   ```bash
   git clone https://github.com/JoelBeer/eregion.git ~/sites/eregion
   cd ~/sites/eregion
   npm install
   ```

3. **Start it:**

   ```bash
   npm start
   ```

   The window opens on Windows, filling the screen.

4. **Optional, add it to the Start menu** so you can open it like any Windows app:

   ```bash
   npm run install-launcher
   ```

   It shows up in the Start menu under Ubuntu, with the anvil icon. If it doesn't appear, run `wsl --shutdown` in Windows and open Ubuntu again.

On Linux, steps 2 and 3 are all there is, and `npm run install-launcher` adds it to your desktop's app list.

## First run

1. **Tools.** The first screen checks git, gh and the agent CLIs, and creates the default crew: Ember plans, Rivet builds, Anvil reviews, Ingot writes PRs.
2. **A project.** Add your repo folders; Eregion reads each one (for a Laravel app it suggests the whole recipe: `.env`, Composer, npm, migrations, build and `php artisan serve`). A project's setup has seven steps:
   1. **Repos**, with their base branch and GitHub remote.
   2. **Variables** that change per ticket, such as `app_port = 8100 + {{slot}}`.
   3. **Setup** steps for a fresh worktree: copy `.env`, set values, install dependencies, migrate, build.
   4. **Services** to run (with a ready check and an Open button) and **teardown** steps.
   5. **Pipeline**: the stages, who runs each, prompts, review loops and Watch CI. Every save keeps the previous version, and History can bring any of them back.
   6. **Linear and GitHub**: which Linear team, what to import and send back, Linear status per stage, draft PRs.
   7. **Test run**: Eregion sets up a throwaway environment with your recipe, starts the services and tears it down.
3. **Tickets.** Issues assigned to you in the project's Linear team appear in the Backlog within a minute. Open one and press **Start planning**.

Setup must be safe to run more than once on the same worktree: seeders that create rows should use `firstOrCreate`-style upserts.

## Connect Linear

Eregion ships no shared Linear app. You register a private one in your own workspace, so nothing about it is public and nobody depends on anyone else's app.

1. In Linear, open **Settings › API › OAuth applications** and create an application. Any name and developer will do. Leave it private.
2. Add these three **callback URLs** (Eregion listens on the first free one while you sign in):

   ```text
   http://127.0.0.1:47321/oauth/callback
   http://127.0.0.1:47322/oauth/callback
   http://127.0.0.1:47323/oauth/callback
   ```

3. In Eregion, open **Settings › Integrations**, paste the app's **client ID** and press **Sign in with Linear**. Approve it in the browser and come back.

No client secret is needed: sign-in uses PKCE. If your workspace doesn't let you create apps, use a **personal API key** instead (Linear › Settings › Security & access › Personal API keys) in the same place.

Then choose the Linear team in the project's **Linear and GitHub** step. Issues assigned to you (or to people you choose in Settings › Integrations) in Backlog or Todo come in automatically. An issue assigned to someone else leaves the Backlog, or gets flagged if work has started. A ticket made in Eregion in a linked project becomes a Linear issue.

## Connect GitHub

Eregion uses the GitHub CLI, signed in as you, inside each repo's runtime:

```bash
gh auth login
```

It pushes branches, opens and links PRs, marks drafts ready, reads checks and job logs, and re-runs failed jobs. It stores no GitHub token.

## Where things live

| | |
| --- | --- |
| App data (projects, tickets, runs, settings) | `~/.config/eregion/eregion.db` (an SQLite file) |
| Ticket worktrees, outputs, plan checkout | `~/.eregion/<project>/` |
| Linear tokens | in the app data, encrypted with Electron's safeStorage (the OS keychain where there is one) |
| Whisper models | the app's cache, downloaded from Hugging Face only when you press Download in Settings › Voice |

Your own checkouts are never written to: tickets work in worktrees, rule-file edits go through a pull request, and the agents can't commit, push or switch branches.

## Develop

```bash
npm run dev          # the app with hot reload
npm test             # the test suite (Vitest)
npm run typecheck    # TypeScript for the main process and the screens
npm run preview:web  # the screens in a browser, with the real backend, on http://localhost:5199
npm run icons        # re-render the app icon from its SVG
```

The stack is Electron, React and TypeScript, built with electron-vite, with better-sqlite3 for storage. `src/main` is the backend (pipeline engine, agents, workspaces, integrations), `src/renderer` the screens, and `src/shared` the types and logic both use. [CLAUDE.md](CLAUDE.md) is the guide for working on the code, and [docs/build-plan.md](docs/build-plan.md) records the decisions made while building it.

## Licence

[MIT](LICENSE)
