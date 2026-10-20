import type { AdapterId } from '@shared/agent'
import { chatTitle, visitor, type Chat, type NewChat } from '@shared/forge'
import type { Project } from '@shared/model'
import { composePrompt, FORGE_PROMPT } from '@shared/prompts'
import { render } from '@shared/template'
import type { RunTooling } from '@shared/tooling'
import type { CrewStore } from './agents/crew'
import type { AgentManager } from './agents/manager'
import type { RunStore } from './agents/runs'
import type { Db } from './db'
import { runnerForRuntimeId } from './projects/detect'
import type { ProjectStore } from './projects/store'
import type { Runner } from './runner/types'
import type { Workspaces } from './workspace/workspaces'

interface ChatRow {
  id: number
  project_id: number
  crew_id: number | null
  adapter: AdapterId
  model: string
  title: string
  repo_ids: string
  created_at: string
  updated_at: string
  cost: number | null
  tokens: number | null
  run_ids: string | null
}

const SELECT = `
  SELECT c.*, SUM(r.cost_usd) AS cost, SUM(COALESCE(r.tokens_in, 0) + COALESCE(r.tokens_out, 0) + COALESCE(r.tokens_cached, 0)) AS tokens, GROUP_CONCAT(r.id) AS run_ids
  FROM chats c LEFT JOIN runs r ON r.chat_id = c.id`

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    crewId: row.crew_id,
    adapter: row.adapter,
    model: row.model,
    repoIds: JSON.parse(row.repo_ids) as number[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    costUsd: row.cost ?? 0,
    tokens: row.tokens ?? 0,
    runIds: (row.run_ids ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
  }
}

export interface ForgeDeps {
  db: Db
  projects: ProjectStore
  crew: CrewStore
  runs: RunStore
  agents: AgentManager
  workspaces: Workspaces
  userName(): string
  houseRules(project: Project): string
  tooling?(project: Project, repoPaths: Record<string, string>): Promise<RunTooling>
  changed(projectId: number): void
  runnerFor?: (runtime: string) => Runner
}

/**
 * The Forge: one-off chats outside any ticket. Each chat is one read-only agent conversation in an
 * empty folder, with any repos you attach as a read-only plan checkout. A chat whose session has
 * ended (after a restart) carries on by resuming it.
 */
export class Forge {
  constructor(private readonly deps: ForgeDeps) {}

  list(projectId: number): Chat[] {
    return (this.deps.db.prepare(`${SELECT} WHERE c.project_id = ? GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC`).all(projectId) as ChatRow[]).map(toChat)
  }

  get(chatId: number): Chat {
    const row = this.deps.db.prepare(`${SELECT} WHERE c.id = ? GROUP BY c.id`).get(chatId) as ChatRow | undefined
    if (!row) throw new Error(`Chat ${chatId} not found`)
    return toChat(row)
  }

  create(projectId: number, chat: NewChat): Chat {
    const model = chat.crewId ? this.deps.crew.get(chat.crewId).model : chat.model
    const adapter = chat.crewId ? this.deps.crew.get(chat.crewId).adapter : chat.adapter
    const id = Number(
      this.deps.db.prepare('INSERT INTO chats (project_id, crew_id, adapter, model, repo_ids) VALUES (?, ?, ?, ?, ?)').run(projectId, chat.crewId, adapter, model, JSON.stringify(chat.repoIds)).lastInsertRowid
    )
    this.deps.changed(projectId)
    return this.get(id)
  }

  update(chatId: number, patch: { title?: string; repoIds?: number[] }): Chat {
    const chat = this.get(chatId)
    if (patch.title !== undefined) this.deps.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(patch.title.trim() || chat.title, chatId)
    if (patch.repoIds !== undefined) this.deps.db.prepare('UPDATE chats SET repo_ids = ? WHERE id = ?').run(JSON.stringify(patch.repoIds), chatId)
    this.deps.changed(chat.projectId)
    return this.get(chatId)
  }

  async remove(chatId: number): Promise<void> {
    const chat = this.get(chatId)
    for (const runId of chat.runIds) if (this.deps.agents.liveState(runId)) await this.deps.agents.stop(runId)
    this.deps.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId)
    this.deps.changed(chat.projectId)
  }

  /** The repos a chat reads: each one's folder in the project's plan checkout, made if missing. */
  private async repoPaths(project: Project, repoIds: number[]): Promise<Record<string, string>> {
    const repos = project.repos.filter((repo) => repoIds.includes(repo.id))
    if (repos.length === 0) return {}
    const folder = await this.deps.workspaces.planFolder(project)
    const runner = (this.deps.runnerFor ?? runnerForRuntimeId)(project.repos[0].runtime)
    // Plans refresh the checkout; the Forge only makes it when it isn't there yet, so a plan isn't disturbed.
    if (!(await runner.exists(runner.join(folder, repos[0].name)))) await this.deps.workspaces.refreshPlanCheckout(project)
    return Object.fromEntries(repos.map((repo) => [repo.name, runner.join(folder, repo.name)]))
  }

  /** Sends a message: into the chat's live session, or by starting (or resuming) one. */
  async send(chatId: number, text: string, dictated = false): Promise<{ runId: number }> {
    const message = text.trim()
    if (!message) throw new Error('Write something first')
    const chat = this.get(chatId)
    const last = chat.runIds.at(-1)
    if (last && this.deps.agents.liveState(last)) {
      this.deps.agents.send(last, message, 'now', dictated)
      this.touch(chat)
      return { runId: last }
    }
    const project = this.deps.projects.get(chat.projectId)
    if (project.repos.length === 0) throw new Error('Add a repo to the project first')
    const member = chat.crewId ? { ...this.deps.crew.get(chat.crewId), model: chat.model } : visitor(chat.adapter, chat.model)
    const runner = (this.deps.runnerFor ?? runnerForRuntimeId)(project.repos[0].runtime)
    const repoPaths = await this.repoPaths(project, chat.repoIds)
    const values: Record<string, string> = {
      'crew.name': member.name,
      'user.name': this.deps.userName(),
      'workspace.repos': Object.entries(repoPaths)
        .map(([name, path]) => `- ${name}: ${path}`)
        .join('\n')
    }
    const systemPrompt = render(composePrompt(FORGE_PROMPT, this.deps.houseRules(project), false), (name) => values[name]).text
    const tooling = this.deps.tooling ? await this.deps.tooling(project, repoPaths) : null
    const resume = last ? (this.deps.runs.get(last).sessionId ?? undefined) : undefined
    const { runId } = this.deps.agents.start({
      chatId,
      stage: 'forge',
      crew: member,
      runner,
      cwd: await this.deps.workspaces.forgeFolder(project),
      prompt: message,
      profile: 'chat',
      addDirs: Object.values(repoPaths),
      conversational: true,
      systemPrompt,
      resume,
      recordPrompt: true,
      mcpConfig: tooling?.mcpConfig,
      allowedTools: tooling?.allowedTools,
      deniedTools: tooling?.deniedTools,
      settings: tooling?.settings
    })
    if (chat.runIds.length === 0) this.deps.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(chatTitle(message), chatId)
    this.touch(chat)
    return { runId }
  }

  private touch(chat: Chat): void {
    this.deps.db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chat.id)
    this.deps.changed(chat.projectId)
  }
}
