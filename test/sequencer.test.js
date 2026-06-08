import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../src/db/leads.js';
import { buildHarness, testConfig, makeClock, seedLeads } from './helpers.js';

test('full lifecycle: new -> invited -> connected -> messaged -> followups -> done', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, clientOpts: { acceptInvite: () => true, reply: () => false } });
  const [id] = seedLeads(h.leads, 1);

  // tick 1: send the invite
  let s = await h.sequencer.tick();
  assert.equal(s.sent?.action, 'invite');
  assert.equal(h.leads.byId(id).status, STATUS.INVITED);

  // tick 2: acceptance detected (mock auto-accepts); too early for DM
  s = await h.sequencer.tick();
  assert.deepEqual(s.connected, [id]);
  assert.equal(h.leads.byId(id).status, STATUS.CONNECTED);
  assert.equal(s.sent, null, 'no DM yet (wait not elapsed)');

  // advance past first-DM wait -> DM #1
  clock.advanceDays(1);
  s = await h.sequencer.tick();
  assert.equal(s.sent?.action, 'message');
  assert.equal(s.sent?.step, 1);
  assert.equal(h.leads.byId(id).status, STATUS.MESSAGED);

  // advance past follow-up 1 wait -> follow-up
  clock.advanceDays(3);
  s = await h.sequencer.tick();
  assert.equal(h.leads.byId(id).status, STATUS.FOLLOWUP_1);

  // advance past follow-up 2 wait -> second follow-up
  clock.advanceDays(4);
  s = await h.sequencer.tick();
  assert.equal(h.leads.byId(id).status, STATUS.FOLLOWUP_2);

  // advance past done wait -> sequence ends
  clock.advanceDays(5);
  s = await h.sequencer.tick();
  assert.deepEqual(s.expired, [id]);
  assert.equal(h.leads.byId(id).status, STATUS.DONE);
});

test('reply detection pulls a lead out of the sequence', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, clientOpts: { acceptInvite: () => true, reply: () => true } });
  const [id] = seedLeads(h.leads, 1);

  await h.sequencer.tick();            // invite
  await h.sequencer.tick();            // accepted
  clock.advanceDays(1);
  await h.sequencer.tick();            // DM #1 -> messaged
  assert.equal(h.leads.byId(id).status, STATUS.MESSAGED);

  const s = await h.sequencer.tick();  // reply detected
  assert.deepEqual(s.replies, [id]);
  assert.equal(h.leads.byId(id).status, STATUS.REPLIED);
});

test('warmup gate blocks all sends until the date passes', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ warmupUntil: '2026-12-31' });
  const h = buildHarness({ clock, config });
  seedLeads(h.leads, 3);
  const s = await h.sequencer.tick();
  assert.match(s.skipped, /warmup/);
  assert.equal(h.leads.counts()[STATUS.NEW], 3, 'nothing left "new" was touched');
});

test('off-hours gate skips outside the work window', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ work: { hoursStart: 0, hoursEnd: 1, days: [1, 2, 3, 4, 5, 6, 7] } });
  const h = buildHarness({ clock, config });
  seedLeads(h.leads, 2);
  const s = await h.sequencer.tick();
  assert.equal(s.skipped, 'off-hours');
});

test('daily invite cap stops outreach for the day', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ limits: { invitesPerDay: 2, invitesPerWeek: 100, invitesPerHour: 100, messagesPerDay: 100, rampUpDays: 0, rampUpStartInvites: 2 } });
  const h = buildHarness({ clock, config });
  seedLeads(h.leads, 5);

  assert.equal((await h.sequencer.tick()).sent?.action, 'invite');
  assert.equal((await h.sequencer.tick()).sent?.action, 'invite');
  assert.equal((await h.sequencer.tick()).sent, null, '3rd invite blocked by daily cap');
  assert.equal(h.db.countEventsSince('invite_sent', 24 * 3600 * 1000, clock()), 2);
});

test('failed connection request marks the lead failed', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, clientOpts: { failConnect: true } });
  const [id] = seedLeads(h.leads, 1);
  const s = await h.sequencer.tick();
  assert.equal(s.sent?.action, 'invite_failed');
  assert.equal(h.leads.byId(id).status, STATUS.FAILED);
});

test('one send per tick (human-like pacing)', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock });
  seedLeads(h.leads, 5);
  const s = await h.sequencer.tick();
  assert.equal(h.client.actions.length, 1, 'exactly one outbound action this tick');
  assert.equal(s.sent?.action, 'invite');
});
