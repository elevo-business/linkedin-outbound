// Lead repository: upsert, query by status, and status transitions.
// Status flow:
//   new -> invited -> connected -> messaged -> followup_1 -> followup_2 -> done
//   (any messaged/followup state) -> replied   (terminal-for-machine)
//   invited -> withdrawn                        (stale pending invite pulled back)
//   any -> failed                              (on hard errors)

export const STATUS = {
  NEW: 'new',
  INVITED: 'invited',
  CONNECTED: 'connected',
  MESSAGED: 'messaged',
  FOLLOWUP_1: 'followup_1',
  FOLLOWUP_2: 'followup_2',
  REPLIED: 'replied',
  DONE: 'done',
  WITHDRAWN: 'withdrawn',
  FAILED: 'failed',
};

export class Leads {
  constructor(db) {
    this.db = db;
  }

  upsert(lead, now = new Date().toISOString()) {
    const existing = this.db.get(
      `SELECT id FROM leads WHERE linkedin_url = $url`,
      { url: lead.linkedin_url }
    );
    if (existing) {
      this.db.run(
        `UPDATE leads SET
           name = COALESCE($name, name),
           headline = COALESCE($headline, headline),
           company = COALESCE($company, company),
           role = COALESCE($role, role),
           location = COALESCE($location, location),
           notes = COALESCE($notes, notes),
           updated_at = $now
         WHERE id = $id`,
        {
          id: existing.id,
          name: lead.name ?? null,
          headline: lead.headline ?? null,
          company: lead.company ?? null,
          role: lead.role ?? null,
          location: lead.location ?? null,
          notes: lead.notes ?? null,
          now,
        }
      );
      return existing.id;
    }
    const res = this.db.run(
      `INSERT INTO leads
         (linkedin_url, name, headline, company, role, location, notes, status, created_at, updated_at)
       VALUES
         ($url, $name, $headline, $company, $role, $location, $notes, 'new', $now, $now)`,
      {
        url: lead.linkedin_url,
        name: lead.name ?? null,
        headline: lead.headline ?? null,
        company: lead.company ?? null,
        role: lead.role ?? null,
        location: lead.location ?? null,
        notes: lead.notes ?? null,
        now,
      }
    );
    return Number(res.lastInsertRowid);
  }

  byStatus(status, limit = 1000) {
    return this.db.all(
      `SELECT * FROM leads WHERE status = $status ORDER BY id ASC LIMIT $limit`,
      { status, limit }
    );
  }

  byId(id) {
    return this.db.get(`SELECT * FROM leads WHERE id = $id`, { id });
  }

  // Leads in any of `statuses` that are due for a status re-check: never checked,
  // or last checked before `cutoffIso`. Oldest-checked first (NULLs sort first in
  // SQLite), capped at `limit`. Used to throttle expensive per-lead navigations.
  dueForCheck(statuses, cutoffIso, limit) {
    const placeholders = statuses.map((_, i) => `$s${i}`).join(', ');
    const params = { cutoff: cutoffIso, limit };
    statuses.forEach((s, i) => { params[`s${i}`] = s; });
    return this.db.all(
      `SELECT * FROM leads
         WHERE status IN (${placeholders})
           AND (last_checked_at IS NULL OR last_checked_at < $cutoff)
         ORDER BY last_checked_at ASC
         LIMIT $limit`,
      params
    );
  }

  // Records that a lead was just checked (does NOT bump updated_at — a check is
  // not a content change).
  markChecked(id, now = new Date().toISOString()) {
    this.db.run(`UPDATE leads SET last_checked_at = $now WHERE id = $id`, { id, now });
  }

  counts() {
    const rows = this.db.all(
      `SELECT status, COUNT(*) AS n FROM leads GROUP BY status`
    );
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // Sets a new status plus an optional timestamp column, always bumps updated_at.
  setStatus(id, status, { stampColumn = null, error = null } = {}, now = new Date().toISOString()) {
    const cols = ['status = $status', 'updated_at = $now'];
    const params = { id, status, now };
    if (stampColumn) {
      cols.push(`${stampColumn} = $stamp`);
      params.stamp = now;
    }
    if (error !== null) {
      cols.push('error = $error');
      params.error = error;
    }
    this.db.run(`UPDATE leads SET ${cols.join(', ')} WHERE id = $id`, params);
  }
}
