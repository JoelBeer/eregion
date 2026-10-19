/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have run.
 * Never edit a released migration; add a new one.
 */
export const migrations: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    initials TEXT NOT NULL,
    color TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    live_slots INTEGER NOT NULL DEFAULT 2 CHECK (live_slots > 0),
    linear TEXT NOT NULL DEFAULT '{}',
    github TEXT NOT NULL DEFAULT '{}',
    setup_step INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    runtime TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    github_repo TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, name)
  );

  CREATE TABLE steps (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('setup', 'teardown')),
    position INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('command', 'set_env', 'copy_file', 'script')),
    config TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE services (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    ready_check TEXT NOT NULL DEFAULT '{}',
    open_url TEXT
  );

  CREATE TABLE pipelines (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    stages TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, version)
  );

  CREATE TABLE crew (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    adapter TEXT NOT NULL CHECK (adapter IN ('claude-code', 'cursor')),
    model TEXT NOT NULL,
    seed INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    linear_id TEXT,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    description TEXT NOT NULL DEFAULT '',
    linear_data TEXT NOT NULL DEFAULT '{}',
    pipeline_version INTEGER,
    stage TEXT NOT NULL DEFAULT 'backlog',
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'running', 'needs_you', 'stopped', 'done')),
    stop_reason TEXT
      CHECK (stop_reason IS NULL OR stop_reason IN ('blocked', 'stuck', 'setup_failed', 'loop_limit', 'ci_needs_you')),
    stop_detail TEXT,
    loop INTEGER NOT NULL DEFAULT 1,
    slot INTEGER,
    branch TEXT,
    affected_repos TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, key)
  );

  CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    crew_id INTEGER REFERENCES crew(id) ON DELETE SET NULL,
    model TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    crew_id INTEGER REFERENCES crew(id) ON DELETE SET NULL,
    adapter TEXT NOT NULL,
    model TEXT NOT NULL,
    loop INTEGER NOT NULL DEFAULT 1,
    session_id TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    result TEXT NOT NULL DEFAULT 'running' CHECK (result IN ('running', 'done', 'failed', 'stopped')),
    tokens_in INTEGER,
    tokens_out INTEGER,
    tokens_cached INTEGER,
    cost_usd REAL,
    CHECK (ticket_id IS NOT NULL OR chat_id IS NOT NULL)
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    dictated INTEGER NOT NULL DEFAULT 0,
    delivery TEXT NOT NULL CHECK (delivery IN ('now', 'queue')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  );

  CREATE TABLE pull_requests (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    draft INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'closed')),
    autofix INTEGER NOT NULL DEFAULT 1,
    autofix_paused_reason TEXT,
    head_sha TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ticket_id, repo_id)
  );

  CREATE TABLE ci_attempts (
    id INTEGER PRIMARY KEY,
    pull_request_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    check_name TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'fixed', 'needs-you')),
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX repos_project ON repos(project_id);
  CREATE INDEX steps_repo ON steps(repo_id, phase, position);
  CREATE INDEX tickets_project ON tickets(project_id, stage);
  CREATE INDEX runs_ticket ON runs(ticket_id);
  CREATE INDEX runs_chat ON runs(chat_id);
  CREATE INDEX events_run ON events(run_id, id);
  CREATE INDEX messages_run ON messages(run_id, status);
  CREATE INDEX ci_attempts_pr ON ci_attempts(pull_request_id, check_name);
  `
]
