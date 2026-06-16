CREATE TABLE IF NOT EXISTS eval_users (
  hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS eval_states (
  hash TEXT NOT NULL,
  eval_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('evaluator')),
  state TEXT NOT NULL CHECK(state IN ('booked', 'revealed')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
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
