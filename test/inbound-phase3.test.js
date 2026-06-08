import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { Posts, POST_STATUS } from '../src/db/posts.js';
import { Engagements, ENGAGEMENT_STATUS as ES } from '../src/db/engagements.js';
import { MockCrmClient } from '../src/crm/MockCrmClient.js';
import { hookStats, pickHook } from '../src/inbound/learning.js';
import { createCaptureServer } from '../src/server/captureServer.js';
import { buildInboundHarness, testConfig, makeClock } from './helpers.js';

function seedScheduledPost(h) {
  const magnetId = h.magnets.create({ name: 'The Guide', description: 'a guide', body: 'BODY', cta: 'comment guide' });
  const postId = h.posts.create({
    magnet_id: magnetId,
    status: POST_STATUS.SCHEDULED,
    body: 'value... comment guide',
    hook: 'listicle',
    trigger_word: 'guide',
    scheduled_at: '2026-06-01T09:00:00Z',
  });
  return { magnetId, postId };
}

// CRM hand-off on reply.
test('inbound reply syncs the engagement to the CRM (once)', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({
    clock,
    clientOpts: { comments: () => [{ name: 'Jane', profileRef: 'jane-1', text: 'guide' }], reply: () => false },
    crmClientOpts: {},
  });
  seedScheduledPost(h);
  await h.sequencer.tick(); // publish -> capture -> deliver
  const eng = h.engagements.byStatus(ES.DELIVERED)[0];
  assert.ok(eng);

  h.client.reply = () => true;
  clock.advanceHours(7);
  await h.sequencer.tick(); // reply -> CRM sync

  assert.ok(h.crm.actions.some((a) => a.type === 'createLead' && a.id === eng.id));
  assert.ok(h.engagements.byId(eng.id).crm_synced_at, 'sync is stamped');
  assert.equal(h.db.countEventsSince('crm_created', 24 * 3600 * 1000, clock()), 1);

  // A second pass does not double-create.
  clock.advanceHours(7);
  await h.sequencer.tick();
  assert.equal(h.crm.actions.filter((a) => a.type === 'createLead').length, 1);
});

// Learning loop.
test('learning: hookStats + bandit favour the best-converting hook', () => {
  const db = new Db(':memory:');
  const posts = new Posts(db);
  const eng = new Engagements(db);
  for (const hook of ['A', 'A']) posts.markPublished(posts.create({ body: 'x', hook }), 'r');
  for (const hook of ['B', 'B']) posts.markPublished(posts.create({ body: 'x', hook }), 'r');
  const aPosts = posts.byStatus('published').filter((p) => p.hook === 'A');
  eng.upsert({ post_id: aPosts[0].id, profile_ref: 'p1' });
  eng.upsert({ post_id: aPosts[0].id, profile_ref: 'p2' });
  eng.upsert({ post_id: aPosts[1].id, profile_ref: 'p3' });

  const stats = hookStats(db);
  assert.equal(stats.A.rate, 1.5);
  assert.equal(stats.B.rate, 0);

  // Exploit (rng high -> not exploration; both explored) picks A.
  assert.equal(pickHook(db, ['A', 'B'], { epsilon: 0.2, rng: () => 0.9 }), 'A');
  // An unexplored hook is tried first.
  assert.equal(pickHook(db, ['A', 'B', 'C'], { rng: () => 0 }), 'C');
});

// Capture server end-to-end.
test('capture server: landing page, email capture, delivery, CRM sync', async () => {
  const config = testConfig({ crm: { createOn: 'both' } });
  const db = new Db(':memory:');
  const magnets = new Magnets(db);
  const engagements = new Engagements(db);
  const crm = new MockCrmClient();
  const mid = magnets.create({ name: 'The Guide', description: 'd', body: 'SECRET-BODY', delivery: 'gated' });
  const magnet = magnets.byId(mid);
  const { id: eid } = engagements.upsert({ post_id: 1, magnet_id: mid, name: 'Jane', profile_ref: 'jane-1' });

  const server = createCaptureServer(config, { db, magnets, engagements, crm });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const g = await fetch(`http://localhost:${port}/m/${magnet.slug}?e=${eid}`);
    const gh = await g.text();
    assert.match(gh, /The Guide/);
    assert.match(gh, /email/i, 'gated page shows an email form');
    assert.equal(db.countEventsSince('magnet_click', 60000, new Date()), 1, 'click tracked');

    const p = await fetch(`http://localhost:${port}/m/${magnet.slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `email=jane%40x.com&e=${eid}`,
    });
    const ph = await p.text();
    assert.match(ph, /SECRET-BODY/, 'resource delivered after capture');
    assert.equal(engagements.byId(eid).email, 'jane@x.com');
    assert.equal(engagements.byId(eid).status, ES.DELIVERED);
    assert.ok(crm.actions.some((a) => a.type === 'createLead'), 'captured lead pushed to CRM');
  } finally {
    server.close();
  }
});

test('capture server: unknown magnet slug 404s', async () => {
  const db = new Db(':memory:');
  const server = createCaptureServer(testConfig(), { db, crm: new MockCrmClient() });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://localhost:${port}/m/nope`);
    assert.equal(res.status, 404);
    const health = await fetch(`http://localhost:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    server.close();
  }
});
