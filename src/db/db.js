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
  email         TEXT,
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
  withdrawn_at  TEXT,
  last_checked_at TEXT,
  email_enrolled_at TEXT,
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

-- ---- Inbound (content-driven) engine ----------------------------------------

-- Campaigns: a dynamic ICP/topic/voice bundle. Many can run in parallel; magnets
-- and posts belong to one. Env INBOUND_* values are only fallback defaults.
CREATE TABLE IF NOT EXISTS campaigns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  icp          TEXT,
  topics       TEXT,          -- comma-separated
  trigger_word TEXT,
  delivery     TEXT NOT NULL DEFAULT 'dm',  -- dm | gated
  value_prop   TEXT,
  sender_name  TEXT,
  sender_role  TEXT,
  status       TEXT NOT NULL DEFAULT 'active', -- active | paused
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Lead magnets: the gated resource a post promises.
CREATE TABLE IF NOT EXISTS magnets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  body        TEXT,           -- generated content (markdown) or a resource URL
  cta         TEXT,           -- the call-to-action line used in posts
  delivery    TEXT NOT NULL DEFAULT 'dm',  -- dm | gated
  url         TEXT,           -- external resource link, if any
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Posts: generated content that promotes a magnet and carries a trigger keyword.
CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER,
  magnet_id    INTEGER,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | published | failed
  body         TEXT NOT NULL,
  hook         TEXT,           -- the variant "hook" label (for the learning loop)
  trigger_word TEXT,           -- comment keyword that requests the magnet
  external_ref TEXT,           -- LinkedIn post URN / URL once published
  scheduled_at TEXT,
  published_at TEXT,
  last_scan_at TEXT,           -- last time we read comments on this post
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);

-- Engagements: people who engaged inbound (commented the trigger / DM'd / etc.).
CREATE TABLE IF NOT EXISTS engagements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id          INTEGER,
  magnet_id        INTEGER,
  name             TEXT,
  linkedin_url     TEXT,
  profile_ref      TEXT,        -- provider id / stable handle
  source           TEXT NOT NULL DEFAULT 'comment', -- comment | dm | reaction
  comment_text     TEXT,
  status           TEXT NOT NULL DEFAULT 'engaged',
  email            TEXT,
  dm_sent_at       TEXT,
  delivered_at     TEXT,
  email_captured_at TEXT,
  replied_at       TEXT,
  exported_at      TEXT,
  last_checked_at  TEXT,
  crm_ref          TEXT,
  crm_synced_at    TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (post_id, profile_ref)
);

CREATE INDEX IF NOT EXISTS idx_engagements_status ON engagements(status);
`;

export class Db {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec(SCHEMA);
    this._migrate();
  }

  // Idempotently add columns that newer versions introduced, so existing
  // databases keep working without a manual migration.
  _migrate() {
    this._ensureCols('leads', {
      withdrawn_at: 'TEXT',
      last_checked_at: 'TEXT',
      email: 'TEXT',
      email_enrolled_at: 'TEXT',
    });
    this._ensureCols('engagements', { crm_ref: 'TEXT', crm_synced_at: 'TEXT' });
    this._ensureCols('magnets', { campaign_id: 'INTEGER' });
    this._ensureCols('posts', { campaign_id: 'INTEGER' });
  }

  _ensureCols(table, defs) {
    const existing = this.all(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const [name, type] of Object.entries(defs)) {
      if (!existing.includes(name)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
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
  // Optionally narrow to a specific `detail` value (e.g. noted vs plain invites).
  countEventsSince(type, ms, now = new Date(), detail = null) {
    const cutoff = new Date(now.getTime() - ms).toISOString();
    if (detail === null) {
      const row = this.get(
        `SELECT COUNT(*) AS n FROM events
         WHERE type = $type AND created_at >= $cutoff`,
        { type, cutoff }
      );
      return row.n;
    }
    const row = this.get(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = $type AND detail = $detail AND created_at >= $cutoff`,
      { type, detail, cutoff }
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

  lastEventTime(type) {
    const row = this.get(
      `SELECT MAX(created_at) AS t FROM events WHERE type = $type`,
      { type }
    );
    return row?.t ?? null;
  }
}
