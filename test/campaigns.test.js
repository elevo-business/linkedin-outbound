import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { Campaigns } from '../src/db/campaigns.js';
import { Posts, POST_STATUS } from '../src/db/posts.js';
import { ContentGenerator, contentContext } from '../src/inbound/contentGenerator.js';
import { buildInboundHarness, testConfig, makeClock } from './helpers.js';

test('campaigns repo: create, resolve by id or name, active/pause', () => {
  const c = new Campaigns(new Db(':memory:'));
  const id = c.create({ name: 'DACH SaaS', icp: 'SaaS founders DACH', topics: ['outbound', 'deliverability'], trigger_word: 'PLAYBOOK', delivery: 'gated' });
  assert.equal(c.byId(id).trigger_word, 'PLAYBOOK');
  assert.equal(c.byId(id).topics, 'outbound,deliverability');
  assert.equal(c.resolve('DACH SaaS').id, id);
  assert.equal(c.resolve(String(id)).id, id);
  assert.equal(c.active().length, 1);
  c.setStatus(id, 'paused');
  assert.equal(c.active().length, 0);
  assert.equal(c.all().length, 1);
});

test('content context: campaign overrides env defaults', () => {
  const cfg = testConfig({ inbound: { icp: 'env people', triggerWord: 'ENV', topics: ['env topic'] } });
  const campaign = { icp: 'CFOs at fintechs', trigger_word: 'CFO', topics: 'finance ops,close', value_prop: 'we automate close' };
  const ctx = contentContext(cfg, campaign);
  assert.equal(ctx.icp, 'CFOs at fintechs');
  assert.equal(ctx.triggerWord, 'CFO');
  assert.deepEqual(ctx.topics, ['finance ops', 'close']);
  // Without a campaign it falls back to env.
  assert.equal(contentContext(cfg, null).icp, 'env people');
});

test('content generator uses the campaign ICP/trigger (template mode)', async () => {
  const cfg = testConfig({ personalizer: { mode: 'template' }, inbound: { icp: 'env people', triggerWord: 'ENV' } });
  const gen = new ContentGenerator(cfg, () => {});
  const campaign = { icp: 'CFOs', trigger_word: 'CFO', topics: 'finance ops' };
  const magnet = await gen.magnet('finance ops', campaign);
  assert.match(magnet.description, /CFOs/);
  assert.match(magnet.cta, /CFO/);
  const post = await gen.post(magnet, 'contrarian', campaign);
  assert.match(post.body, /Most CFOs get this backwards/);
  assert.equal(post.trigger_word, 'CFO');
});

test('sequencer scans each post with its OWN trigger word', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({
    clock,
    clientOpts: {
      comments: () => [
        { name: 'Yes', profileRef: 'yes-1', text: 'send me the PLAYBOOK please' },
        { name: 'No', profileRef: 'no-1', text: 'guide?' }, // env default word, but not this post's trigger
      ],
    },
  });
  const magnetId = h.magnets.create({ name: 'M', body: 'b', delivery: 'dm' });
  h.posts.create({ magnet_id: magnetId, status: POST_STATUS.SCHEDULED, body: 'x', hook: 'q', trigger_word: 'PLAYBOOK', scheduled_at: '2026-06-01T09:00:00Z' });

  const s = await h.sequencer.tick();
  assert.equal(s.engaged.length, 1, 'only the comment matching this post’s trigger word counts');
  assert.equal(h.engagements.byId(s.engaged[0]).name, 'Yes');
});
