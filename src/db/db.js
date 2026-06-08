// Thin wrapper around Node's built-in SQLite (node:sqlite, Node >= 22.5).
// No native dependency, no `npm install` needed for the core logic.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Mute only the noisy "SQLite is an experimental feature" warning; keep all others.
const _origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const msg = typeof warning === 'string' ? warning : warning?.message || '';
  if (/SQLite is an experimental feature/i.test(msg)) return undefined;
  return _origEmitWarning.call(process, warning, ...args);
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  linkedin_url  TEXT UNIQUE NOT NULL,
  name          TEXT,
  headline      TEXT,
  company       TEXT,
  role          TEXT,
  location      TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'new',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  invited_at    TEXT,
  connected_at  TEXT,
  messaged_at   TEXT,
  followup1_at  TEXT,
  followup2_at  TEXT,
  replied_at    TEXT,
  done_at       TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER,
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, created_at);
`;

export class Db {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec(SCHEMA);
  }

  close() {
    this.sqlite.close();
  }

  run(sql, params = {}) {
    return this.sqlite.prepare(sql).run(params);
  }

  get(sql, params = {}) {
    return this.sqlite.prepare(sql).get(params);
  }

  all(sql, params = {}) {
    return this.sqlite.prepare(sql).all(params);
  }

  logEvent(leadId, type, detail = null, now = new Date().toISOString()) {
    this.run(
      `INSERT INTO events (lead_id, type, detail, created_at)
       VALUES ($lead_id, $type, $detail, $created_at)`,
      { lead_id: leadId ?? null, type, detail, created_at: now }
    );
  }

  // Counts events of a given type within the last `ms` milliseconds from `now`.
  countEventsSince(type, ms, now = new Date()) {
    const cutoff = new Date(now.getTime() - ms).toISOString();
    const row = this.get(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = $type AND created_at >= $cutoff`,
      { type, cutoff }
    );
    return row.n;
  }

  firstEventTime(type) {
    const row = this.get(
      `SELECT MIN(created_at) AS t FROM events WHERE type = $type`,
      { type }
    );
    return row?.t ?? null;
  }
}
