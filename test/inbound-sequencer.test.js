import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST_STATUS } from '../src/db/posts.js';
import { ENGAGEMENT_STATUS as ES } from '../src/db/engagements.js';
import { buildInboundHarness, testConfig, makeClock } from './helpers.js';

const PAST = '2026-06-01T09:00:00Z';

function seedScheduledPost(h, { trigger = 'guide', delivery = 'dm' } = {}) {
  const magnetId = h.magnets.create({ name: 'The Guide', description: 'a guide', cta: `comment ${trigger}`, body: 'x', delivery });
  const postId = h.posts.create({
    magnet_id: magnetId,
    status: POST_STATUS.SCHEDULED,
    body: 'value... comment guide',
    hook: 'listicle',
    trigger_word: trigger,
    scheduled_at: PAST,
  });
  return { magnetId, postId };
}

test('inbound full loop: publish -> capture -> accept -> deliver', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const comment = { name: 'Jane Doe', profileRef: 'jane-1', profileUrl: 'https://linkedin.com/in/jane', text: 'guide please!' };
  const h = buildInboundHarness({
    clock,
    clientOpts: {
      comments: () => [comment],
      pendingInvites: () => [{ name: 'Jane Doe', profileRef: 'jane-1', invitationId: 'inv-1' }],
    },
  });
  const { postId } = seedScheduledPost(h);

  const s = await h.sequencer.tick();
  assert.deepEqual(s.published, [postId]);
  assert.equal(h.posts.byId(postId).status, POST_STATUS.PUBLISHED);
  assert.equal(s.engaged.length, 1, 'the trigger-word comment created an engagement');
  assert.deepEqual(s.accepted, ['jane-1'], 'engaged inviter auto-accepted');
  assert.equal(s.delivered.length, 1, 'magnet DM delivered');

  const eng = h.engagements.byStatus(ES.DELIVERED);
  assert.equal(eng.length, 1);
  assert.equal(eng[0].name, 'Jane Doe');

  const dm = h.client.actions.find((a) => a.type === 'message');
  assert.match(dm.text, /\/m\/the-guide\?e=/, 'DM carries a tracked magnet link');
});

test('only comments containing the trigger word create engagements', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({
    clock,
    clientOpts: { comments: () => [{ name: 'Bob', profileRef: 'bob-1', text: 'great post!' }] },
  });
  seedScheduledPost(h);
  const s = await h.sequencer.tick();
  assert.equal(s.engaged.length, 0);
});

test('auto-accept ignores invites from people who did not engage', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({
    clock,
    clientOpts: {
      comments: () => [],
      pendingInvites: () => [{ name: 'Stranger', profileRef: 'stranger-9', invitationId: 'inv-9' }],
    },
  });
  seedScheduledPost(h);
  const s = await h.sequencer.tick();
  assert.equal(s.accepted.length, 0);
  assert.ok(!h.client.actions.some((a) => a.type === 'accept'));
});

test('a reply to the magnet DM hands the conversation over', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({
    clock,
    clientOpts: { comments: () => [{ name: 'Jane', profileRef: 'jane-1', text: 'guide' }], reply: () => false },
  });
  seedScheduledPost(h);
  await h.sequencer.tick(); // delivered
  const eng = h.engagements.byStatus(ES.DELIVERED)[0];
  assert.ok(eng);

  h.client.reply = () => true;
  clock.advanceHours(7); // past the check interval
  const s = await h.sequencer.tick();
  assert.deepEqual(s.replies, [eng.id]);
  assert.equal(h.engagements.byId(eng.id).status, ES.REPLIED);
});

test('gated delivery (per magnet) marks dm_sent, not delivered', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({
    clock,
    clientOpts: { comments: () => [{ name: 'Jane', profileRef: 'jane-1', text: 'guide' }] },
  });
  seedScheduledPost(h, { delivery: 'gated' });
  const s = await h.sequencer.tick();
  assert.equal(s.delivered.length, 1);
  assert.equal(h.engagements.byStatus(ES.DM_SENT).length, 1, 'gated mode waits for email capture');
  assert.equal(h.engagements.byStatus(ES.DELIVERED).length, 0);
});

test('inbound circuit breaker: blocked client pauses the tick', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildInboundHarness({ clock, clientOpts: { blocked: true } });
  seedScheduledPost(h);
  const s = await h.sequencer.tick();
  assert.match(s.skipped, /circuit-breaker tripped/);
  assert.ok(h.db.lastEventTime('circuit_break'));
});
