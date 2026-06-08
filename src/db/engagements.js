// Engagement repository: people who engaged inbound (commented the trigger word,
// DM'd for the magnet, ...). Lifecycle:
//   engaged -> dm_sent -> delivered -> done
//   (any) -> replied   (they responded conversationally; you take over)
//   (any) -> failed

export const ENGAGEMENT_STATUS = {
  ENGAGED: 'engaged',
  DM_SENT: 'dm_sent',
  DELIVERED: 'delivered',
  REPLIED: 'replied',
  DONE: 'done',
  FAILED: 'failed',
};

export class Engagements {
  constructor(db) {
    this.db = db;
  }

  // Idempotent on (post_id, profile_ref): a person commenting twice on the same
  // post is one engagement. Returns { id, created }.
  upsert(e, now = new Date().toISOString()) {
    const existing =
      e.profile_ref != null
        ? this.db.get(
            `SELECT id FROM engagements WHERE post_id IS $post AND profile_ref = $ref`,
            { post: e.post_id ?? null, ref: e.profile_ref }
          )
        : null;
    if (existing) {
      this.db.run(
        `UPDATE engagements SET
           name = COALESCE($name, name),
           linkedin_url = COALESCE($url, linkedin_url),
           comment_text = COALESCE($comment, comment_text),
           updated_at = $now
         WHERE id = $id`,
        {
          id: existing.id,
          name: e.name ?? null,
          url: e.linkedin_url ?? null,
          comment: e.comment_text ?? null,
          now,
        }
      );
      return { id: existing.id, created: false };
    }
    const res = this.db.run(
      `INSERT INTO engagements
         (post_id, magnet_id, name, linkedin_url, profile_ref, source, comment_text, status, created_at, updated_at)
       VALUES
         ($post_id, $magnet_id, $name, $url, $ref, $source, $comment, 'engaged', $now, $now)`,
      {
        post_id: e.post_id ?? null,
        magnet_id: e.magnet_id ?? null,
        name: e.name ?? null,
        url: e.linkedin_url ?? null,
        ref: e.profile_ref ?? null,
        source: e.source ?? 'comment',
        comment: e.comment_text ?? null,
        now,
      }
    );
    return { id: Number(res.lastInsertRowid), created: true };
  }

  byId(id) {
    return this.db.get(`SELECT * FROM engagements WHERE id = $id`, { id });
  }

  byStatus(status, limit = 1000) {
    return this.db.all(
      `SELECT * FROM engagements WHERE status = $status ORDER BY id ASC LIMIT $limit`,
      { status, limit }
    );
  }

  // Engagements in `statuses` due for a re-check (reply detection), throttled.
  dueForCheck(statuses, cutoffIso, limit) {
    const placeholders = statuses.map((_, i) => `$s${i}`).join(', ');
    const params = { cutoff: cutoffIso, limit };
    statuses.forEach((s, i) => { params[`s${i}`] = s; });
    return this.db.all(
      `SELECT * FROM engagements
         WHERE status IN (${placeholders})
           AND (last_checked_at IS NULL OR last_checked_at < $cutoff)
         ORDER BY last_checked_at ASC LIMIT $limit`,
      params
    );
  }

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
    this.db.run(`UPDATE engagements SET ${cols.join(', ')} WHERE id = $id`, params);
  }

  setEmail(id, email, now = new Date().toISOString()) {
    this.db.run(
      `UPDATE engagements SET email = $email, email_captured_at = $now, updated_at = $now WHERE id = $id`,
      { id, email, now }
    );
  }

  markChecked(id, now = new Date().toISOString()) {
    this.db.run(`UPDATE engagements SET last_checked_at = $now WHERE id = $id`, { id, now });
  }

  // Captured-but-not-yet-exported emails, for hand-off to Instantly.
  pendingExport(limit = 1000) {
    return this.db.all(
      `SELECT * FROM engagements
         WHERE email IS NOT NULL AND exported_at IS NULL
         ORDER BY id ASC LIMIT $limit`,
      { limit }
    );
  }

  markExported(id, now = new Date().toISOString()) {
    this.db.run(`UPDATE engagements SET exported_at = $now, updated_at = $now WHERE id = $id`, { id, now });
  }

  counts() {
    const rows = this.db.all(`SELECT status, COUNT(*) AS n FROM engagements GROUP BY status`);
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}
