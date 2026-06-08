// Post repository: generated content that promotes a magnet, carries a trigger
// keyword for comment capture, and moves draft -> scheduled -> published.

export const POST_STATUS = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'published',
  FAILED: 'failed',
};

export class Posts {
  constructor(db) {
    this.db = db;
  }

  create(post, now = new Date().toISOString()) {
    const res = this.db.run(
      `INSERT INTO posts (campaign_id, magnet_id, status, body, hook, trigger_word, scheduled_at, created_at, updated_at)
       VALUES ($campaign_id, $magnet_id, $status, $body, $hook, $trigger_word, $scheduled_at, $now, $now)`,
      {
        campaign_id: post.campaign_id ?? null,
        magnet_id: post.magnet_id ?? null,
        status: post.status ?? POST_STATUS.DRAFT,
        body: post.body,
        hook: post.hook ?? null,
        trigger_word: post.trigger_word ?? null,
        scheduled_at: post.scheduled_at ?? null,
        now,
      }
    );
    return Number(res.lastInsertRowid);
  }

  byId(id) {
    return this.db.get(`SELECT * FROM posts WHERE id = $id`, { id });
  }

  byStatus(status, limit = 1000) {
    return this.db.all(
      `SELECT * FROM posts WHERE status = $status ORDER BY id ASC LIMIT $limit`,
      { status, limit }
    );
  }

  // Scheduled posts whose time has come.
  due(nowIso, limit = 1) {
    return this.db.all(
      `SELECT * FROM posts
         WHERE status = 'scheduled' AND (scheduled_at IS NULL OR scheduled_at <= $now)
         ORDER BY scheduled_at ASC, id ASC LIMIT $limit`,
      { now: nowIso, limit }
    );
  }

  // Published posts due for a fresh comment scan (throttled via last_scan_at).
  needingScan(cutoffIso, limit) {
    return this.db.all(
      `SELECT * FROM posts
         WHERE status = 'published'
           AND (last_scan_at IS NULL OR last_scan_at < $cutoff)
         ORDER BY last_scan_at ASC LIMIT $limit`,
      { cutoff: cutoffIso, limit }
    );
  }

  markPublished(id, externalRef, now = new Date().toISOString()) {
    this.db.run(
      `UPDATE posts SET status = 'published', external_ref = $ref, published_at = $now, updated_at = $now WHERE id = $id`,
      { id, ref: externalRef ?? null, now }
    );
  }

  markFailed(id, error, now = new Date().toISOString()) {
    this.db.run(
      `UPDATE posts SET status = 'failed', error = $error, updated_at = $now WHERE id = $id`,
      { id, error: error ?? null, now }
    );
  }

  markScanned(id, now = new Date().toISOString()) {
    this.db.run(`UPDATE posts SET last_scan_at = $now WHERE id = $id`, { id, now });
  }

  schedule(id, scheduledAtIso, now = new Date().toISOString()) {
    this.db.run(
      `UPDATE posts SET status = 'scheduled', scheduled_at = $at, updated_at = $now WHERE id = $id`,
      { id, at: scheduledAtIso, now }
    );
  }

  updateBody(id, body, now = new Date().toISOString()) {
    this.db.run(`UPDATE posts SET body = $body, updated_at = $now WHERE id = $id`, { id, body, now });
  }

  setImage(id, imagePath, imagePrompt, now = new Date().toISOString()) {
    this.db.run(
      `UPDATE posts SET image_path = $p, image_prompt = $prompt, updated_at = $now WHERE id = $id`,
      { id, p: imagePath ?? null, prompt: imagePrompt ?? null, now }
    );
  }

  remove(id) {
    this.db.run(`DELETE FROM posts WHERE id = $id`, { id });
  }

  counts() {
    const rows = this.db.all(`SELECT status, COUNT(*) AS n FROM posts GROUP BY status`);
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}
