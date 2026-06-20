CREATE TABLE IF NOT EXISTS eval_users (
  hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS eval_states (
  hash TEXT NOT NULL,
  eval_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('evaluator')),
  state TEXT NOT NULL CHECK(state IN ('booked', 'revealed')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  begin_at TEXT,
  PRIMARY KEY (hash, eval_id, role)
);

CREATE TABLE IF NOT EXISTS pending_notifs (
  hash TEXT NOT NULL,
  eval_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  data TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (hash, eval_id, role)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS correction_point_historics (
  hash TEXT NOT NULL,
  historic_id INTEGER NOT NULL,
  sum INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (hash, historic_id)
);

CREATE TABLE IF NOT EXISTS outstanding_projects (
  hash TEXT NOT NULL,
  scale_team_id INTEGER NOT NULL,
  projects_user_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (hash, scale_team_id)
);

CREATE TABLE IF NOT EXISTS outstanding_sync_state (
  hash TEXT PRIMARY KEY,
  completed_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
