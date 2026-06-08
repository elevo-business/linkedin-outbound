// Lead-magnet repository: the gated resource a post promises in exchange for a
// comment / email. `slug` is the stable handle used in capture URLs.

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'magnet';

export class Magnets {
  constructor(db) {
    this.db = db;
  }

  create(magnet, now = new Date().toISOString()) {
    const base = magnet.slug ? slugify(magnet.slug) : slugify(magnet.name);
    const slug = this._uniqueSlug(base);
    const res = this.db.run(
      `INSERT INTO magnets (campaign_id, slug, name, description, body, cta, delivery, url, created_at, updated_at)
       VALUES ($campaign_id, $slug, $name, $description, $body, $cta, $delivery, $url, $now, $now)`,
      {
        campaign_id: magnet.campaign_id ?? null,
        slug,
        name: magnet.name,
        description: magnet.description ?? null,
        body: magnet.body ?? null,
        cta: magnet.cta ?? null,
        delivery: magnet.delivery ?? 'dm',
        url: magnet.url ?? null,
        now,
      }
    );
    return Number(res.lastInsertRowid);
  }

  _uniqueSlug(base) {
    let slug = base;
    let i = 2;
    while (this.db.get(`SELECT id FROM magnets WHERE slug = $slug`, { slug })) {
      slug = `${base}-${i++}`;
    }
    return slug;
  }

  byId(id) {
    return this.db.get(`SELECT * FROM magnets WHERE id = $id`, { id });
  }

  bySlug(slug) {
    return this.db.get(`SELECT * FROM magnets WHERE slug = $slug`, { slug });
  }

  all() {
    return this.db.all(`SELECT * FROM magnets ORDER BY id ASC`);
  }

  byCampaign(campaignId) {
    return this.db.get(`SELECT * FROM magnets WHERE campaign_id = $id ORDER BY id ASC`, { id: campaignId });
  }
}
