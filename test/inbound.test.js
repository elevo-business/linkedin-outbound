import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { Posts, POST_STATUS } from '../src/db/posts.js';
import { Engagements, ENGAGEMENT_STATUS } from '../src/db/engagements.js';
import { ContentGenerator, POST_HOOKS } from '../src/inbound/contentGenerator.js';
import { testConfig } from './helpers.js';

function db() {
  return new Db(':memory:');
}

test('magnets: create assigns a unique slug and round-trips', () => {
  const m = new Magnets(db());
  const id1 = m.create({ name: 'The Outbound Playbook', description: 'x', body: 'b', cta: 'c' });
  const id2 = m.create({ name: 'The Outbound Playbook' }); // same name -> different slug
  const a = m.byId(id1);
  const b = m.byId(id2);
  assert.equal(a.slug, 'the-outbound-playbook');
  assert.notEqual(a.slug, b.slug);
  assert.equal(m.bySlug('the-outbound-playbook').id, id1);
});

test('posts: draft -> scheduled -> due -> published, and scan throttling', () => {
  const p = new Posts(db());
  const id = p.create({ body: 'hello', hook: 'listicle', trigger_word: 'guide' });
  assert.equal(p.byId(id).status, POST_STATUS.DRAFT);

  const past = new Date(Date.now() - 1000).toISOString();
  p.schedule(id, past);
  const due = p.due(new Date().toISOString());
  assert.equal(due.length, 1);
  assert.equal(due[0].id, id);

  p.markPublished(id, 'urn:li:post:123');
  assert.equal(p.byId(id).status, POST_STATUS.PUBLISHED);
  assert.equal(p.byId(id).external_ref, 'urn:li:post:123');

  // needingScan respects last_scan_at vs cutoff.
  const cutoff = new Date().toISOString();
  assert.equal(p.needingScan(cutoff, 10).length, 1, 'never scanned -> due');
  p.markScanned(id, new Date().toISOString());
  assert.equal(p.needingScan(new Date(Date.now() - 1000).toISOString(), 10).length, 0, 'recently scanned -> not due');
});

test('engagements: dedupe on (post, profile) and status transitions', () => {
  const e = new Engagements(db());
  const a = e.upsert({ post_id: 1, magnet_id: 1, name: 'Jane', profile_ref: 'jane-1', comment_text: 'guide' });
  assert.equal(a.created, true);
  const again = e.upsert({ post_id: 1, profile_ref: 'jane-1', comment_text: 'guide please' });
  assert.equal(again.created, false, 'same person on same post is one engagement');
  assert.equal(again.id, a.id);

  e.setStatus(a.id, ENGAGEMENT_STATUS.DM_SENT, { stampColumn: 'dm_sent_at' });
  assert.equal(e.byId(a.id).status, ENGAGEMENT_STATUS.DM_SENT);
  assert.ok(e.byId(a.id).dm_sent_at);

  e.setEmail(a.id, 'jane@example.com');
  assert.equal(e.byId(a.id).email, 'jane@example.com');
  assert.equal(e.pendingExport().length, 1);
  e.markExported(a.id);
  assert.equal(e.pendingExport().length, 0);
});

test('content generator (template mode) produces a magnet and on-brand posts', async () => {
  const config = testConfig({
    personalizer: { mode: 'template', valueProp: 'I help SaaS founders book demos' },
    inbound: { icp: 'SaaS founders', topics: ['demo booking'], triggerWord: 'DEMO', deliveryMode: 'dm' },
  });
  const gen = new ContentGenerator(config, () => {});

  const magnet = await gen.magnet('demo booking');
  assert.match(magnet.name, /Demo Booking/i);
  assert.match(magnet.cta, /DEMO/);
  assert.ok(magnet.body.length > 50);

  const post = await gen.post(magnet, 'contrarian');
  assert.equal(post.hook, 'contrarian');
  assert.equal(post.trigger_word, 'DEMO');
  assert.match(post.body, /DEMO/);
  assert.match(post.body, new RegExp(magnet.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Every hook variant generates a distinct opener.
  const bodies = new Set();
  for (const h of POST_HOOKS) bodies.add((await gen.post(magnet, h)).body);
  assert.equal(bodies.size, POST_HOOKS.length, 'each hook yields a different post');
});
