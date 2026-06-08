// The "continuously learning" layer. No ML engine — just honest outcome tracking
// plus a small multi-armed bandit over the post hooks. Each published post is an
// arm-pull; engagements captured on it are the reward. Over time the machine
// leans toward the hooks that actually convert for THIS audience, while still
// exploring so it can adapt.

// Per-hook stats from real outcomes: posts published and engagements captured.
export function hookStats(db) {
  const out = {};
  for (const r of db.all(
    `SELECT hook, COUNT(*) AS posts FROM posts WHERE status = 'published' GROUP BY hook`
  )) {
    if (r.hook) out[r.hook] = { posts: r.posts, engagements: 0, rate: 0 };
  }
  for (const r of db.all(
    `SELECT p.hook AS hook, COUNT(e.id) AS engagements
       FROM posts p JOIN engagements e ON e.post_id = p.id
       WHERE p.status = 'published'
       GROUP BY p.hook`
  )) {
    if (out[r.hook]) out[r.hook].engagements = r.engagements;
  }
  for (const h of Object.keys(out)) {
    out[h].rate = out[h].posts ? out[h].engagements / out[h].posts : 0;
  }
  return out;
}

// Epsilon-greedy pick. Unexplored hooks are tried first (optimistic), then we
// exploit the best-converting hook with occasional random exploration.
export function pickHook(db, hooks, { epsilon = 0.2, rng = Math.random } = {}) {
  if (!hooks.length) return null;
  const stats = hookStats(db);
  const unexplored = hooks.filter((h) => !(stats[h] && stats[h].posts));
  if (unexplored.length) return unexplored[Math.floor(rng() * unexplored.length)];
  if (rng() < epsilon) return hooks[Math.floor(rng() * hooks.length)];
  return hooks.reduce((best, h) => ((stats[h]?.rate ?? 0) > (stats[best]?.rate ?? -1) ? h : best), hooks[0]);
}
