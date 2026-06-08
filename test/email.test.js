import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../src/db/leads.js';
import { buildHarness, testConfig, makeClock, seedLeads } from './helpers.js';

const emailConfig = (over = {}) =>
  testConfig({
    email: { channel: 'mock', handoffOnWithdraw: true, instantly: { baseUrl: '', apiKey: '', campaignId: '' } },
    invites: { attachNote: true, maxNotedPerMonth: 5, withdrawAfterDays: 21, maxWithdrawalsPerTick: 5 },
    ...over,
  });

// #6 — a withdrawn LinkedIn invite hands the lead off to the email channel.
test('stale LinkedIn invite hands off to email when the lead has an address', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, config: emailConfig(), emailClientOpts: { reply: () => false } });

  const ids = seedLeads(h.leads, 2, 'p', { withEmail: true });
  for (const id of ids) h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());
  clock.advanceDays(30);

  const s = await h.sequencer.tick();
  assert.deepEqual(s.withdrawn.sort(), ids.slice().sort());
  assert.deepEqual(s.enrolled.sort(), ids.slice().sort(), 'both withdrawn leads were enrolled in email');
  for (const id of ids) assert.ok(h.leads.byId(id).email_enrolled_at, 'enrollment is stamped');
  const enrolls = h.email.actions.filter((a) => a.type === 'enroll');
  assert.equal(enrolls.length, 2);
});

test('leads without an email are NOT handed off', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, config: emailConfig(), emailClientOpts: {} });
  const [id] = seedLeads(h.leads, 1); // no email
  h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());
  clock.advanceDays(30);
  const s = await h.sequencer.tick();
  assert.equal(s.withdrawn.length, 1);
  assert.equal(s.enrolled.length, 0);
  assert.equal(h.leads.byId(id).email_enrolled_at, null);
});

// #6 — an email reply pulls the lead out of the machine.
test('email reply marks the lead replied', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, config: emailConfig(), emailClientOpts: { reply: () => true } });

  const [id] = seedLeads(h.leads, 1, 'p', { withEmail: true });
  h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());
  clock.advanceDays(30);

  // tick 1: withdraw + enroll in email.
  await h.sequencer.tick();
  assert.ok(h.leads.byId(id).email_enrolled_at);

  // tick 2 (after the check interval): the email reply is detected.
  clock.advanceHours(7);
  const s = await h.sequencer.tick();
  assert.deepEqual(s.replies, [id]);
  assert.equal(h.leads.byId(id).status, STATUS.REPLIED);
});

// #6 — a LinkedIn reply pauses the email sequence (no double-touch).
test('a LinkedIn reply pauses the email sequence for an enrolled lead', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, config: emailConfig(), emailClientOpts: { reply: () => false } });

  const [id] = seedLeads(h.leads, 1, 'p', { withEmail: true });
  // Lead is messaged on LinkedIn AND already enrolled in email.
  h.leads.setStatus(id, STATUS.MESSAGED, { stampColumn: 'messaged_at' }, clock().toISOString());
  h.leads.markEmailEnrolled(id, clock().toISOString());
  // Now they reply on LinkedIn.
  h.client.reply = () => true;

  clock.advanceHours(7);
  const s = await h.sequencer.tick();
  assert.deepEqual(s.replies, [id]);
  assert.equal(h.leads.byId(id).status, STATUS.REPLIED);
  assert.ok(h.email.actions.some((a) => a.type === 'pause'), 'email sequence was paused');
});

// EMAIL_CHANNEL=none keeps everything LinkedIn-only.
test('email channel disabled: no enrollment, no email actions', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock }); // default NullEmailClient
  const [id] = seedLeads(h.leads, 1, 'p', { withEmail: true });
  h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());
  clock.advanceDays(30);
  const s = await h.sequencer.tick();
  assert.equal(s.withdrawn.length, 1);
  assert.equal(s.enrolled.length, 0);
});
