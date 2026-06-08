// Campaign repository: a dynamic ICP/topic/voice bundle. Magnets and posts belong
// to a campaign; the inbound engine reads the campaign's settings (not a single
// global env value), so you can run many ICPs in parallel.

export class Campaigns {
  constructor(db) {
    this.db = db;
  }

  create(c, now = new Date().toISOString()) {
    const res = this.db.run(
      `INSERT INTO campaigns
         (name, icp, topics, trigger_word, delivery, value_prop, sender_name, sender_role, language, status, created_at, updated_at)
       VALUES
         ($name, $icp, $topics, $trigger, $delivery, $vp, $sn, $sr, $language, $status, $now, $now)`,
      {
        name: c.name,
        icp: c.icp ?? null,
        topics: Array.isArray(c.topics) ? c.topics.join(',') : (c.topics ?? null),
        trigger: c.trigger_word ?? null,
        delivery: c.delivery ?? 'dm',
        vp: c.value_prop ?? null,
        sn: c.sender_name ?? null,
        sr: c.sender_role ?? null,
        language: c.language ?? null,
        status: c.status ?? 'active',
        now,
      }
    );
    return Number(res.lastInsertRowid);
  }

  byId(id) {
    return this.db.get(`SELECT * FROM campaigns WHERE id = $id`, { id });
  }

  byName(name) {
    return this.db.get(`SELECT * FROM campaigns WHERE name = $name ORDER BY id ASC`, { name });
  }

  // Accepts a numeric id or a name.
  resolve(ref) {
    if (ref == null) return null;
    const asNum = Number(ref);
    return Number.isInteger(asNum) && String(asNum) === String(ref) ? this.byId(asNum) : this.byName(String(ref));
  }

  all() {
    return this.db.all(`SELECT * FROM campaigns ORDER BY id ASC`);
  }

  active() {
    return this.db.all(`SELECT * FROM campaigns WHERE status = 'active' ORDER BY id ASC`);
  }

  setStatus(id, status, now = new Date().toISOString()) {
    this.db.run(`UPDATE campaigns SET status = $status, updated_at = $now WHERE id = $id`, { id, status, now });
  }

  topicsList(campaign) {
    return campaign?.topics ? campaign.topics.split(',').map((t) => t.trim()).filter(Boolean) : [];
  }
}
