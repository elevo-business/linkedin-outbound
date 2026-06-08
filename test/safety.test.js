import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../src/db/leads.js';
import { buildHarness, testConfig, makeClock, seedLeads } from './helpers.js';
import { sanitize } from '../src/ai/personalizer.js';

// #1 — bookkeeping checks are throttled per tick and per interval.
test('status checks are bounded by maxPerTick and re-check interval', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ checks: { intervalHours: 6, maxPerTick: 2 } });
  let checkCalls = 0;
  const h = buildHarness({
    clock,
    config,
    clientOpts: { acceptInvite: () => { checkCalls++; return false; } },
  });

  const ids = seedLeads(h.leads, 5);
  for (const id of ids) h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());

  await h.sequencer.tick();
  assert.equal(checkCalls, 2, 'first tick checks at most maxPerTick leads');

  await h.sequencer.tick();
  assert.equal(checkCalls, 4, 'second tick checks the next batch, not the already-checked ones');

  // Within the interval the same leads are not re-checked again — only the one
  // still-unchecked lead is picked up.
  clock.advanceHours(1);
  await h.sequencer.tick();
  assert.equal(checkCalls, 5, 'third tick picks up the last unchecked lead (1 remaining)');

  // After the interval elapses, previously-checked leads become due again
  // (bounded by maxPerTick).
  clock.advanceHours(6);
  await h.sequencer.tick();
  assert.equal(checkCalls, 7, 'after the interval, leads are re-checked, capped at maxPerTick');
});

// #2 — once the monthly NOTED-invite budget is spent, invites go out note-less.
test('invites drop the note after the monthly noted-invite budget is spent', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ invites: { attachNote: true, maxNotedPerMonth: 2, withdrawAfterDays: 21, maxWithdrawalsPerTick: 2 } });
  const h = buildHarness({ clock, config });
  seedLeads(h.leads, 5);

  const s1 = await h.sequencer.tick();
  const s2 = await h.sequencer.tick();
  const s3 = await h.sequencer.tick();

  assert.equal(s1.sent.noted, true);
  assert.equal(s2.sent.noted, true);
  assert.equal(s3.sent.noted, false, 'third invite is note-less (budget = 2)');

  const invites = h.client.actions.filter((a) => a.type === 'invite');
  assert.equal(typeof invites[0].note, 'string');
  assert.equal(invites[2].note, null, 'note-less invite carries no note');
});

test('ATTACH_NOTE=false sends every invite without a note', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ invites: { attachNote: false, maxNotedPerMonth: 5, withdrawAfterDays: 21, maxWithdrawalsPerTick: 2 } });
  const h = buildHarness({ clock, config });
  seedLeads(h.leads, 2);
  const s = await h.sequencer.tick();
  assert.equal(s.sent.noted, false);
  assert.equal(h.client.actions.at(-1).note, null);
});

// #3 — stale pending invites get withdrawn, bounded per tick.
test('stale pending invites are withdrawn, bounded per tick', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ invites: { attachNote: true, maxNotedPerMonth: 5, withdrawAfterDays: 21, maxWithdrawalsPerTick: 2 } });
  const h = buildHarness({ clock, config });

  const ids = seedLeads(h.leads, 3);
  for (const id of ids) h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());

  clock.advanceDays(30); // all three are now well past the 21-day threshold

  const s1 = await h.sequencer.tick();
  assert.equal(s1.withdrawn.length, 2, 'at most maxWithdrawalsPerTick withdrawn per tick');
  for (const id of s1.withdrawn) assert.equal(h.leads.byId(id).status, STATUS.WITHDRAWN);

  const s2 = await h.sequencer.tick();
  assert.equal(s2.withdrawn.length, 1, 'the remaining stale invite is withdrawn next tick');
  assert.equal(h.leads.counts()[STATUS.WITHDRAWN], 3);
});

test('fresh pending invites are NOT withdrawn', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock });
  const ids = seedLeads(h.leads, 2);
  for (const id of ids) h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());
  clock.advanceDays(5); // younger than the 21-day default
  const s = await h.sequencer.tick();
  assert.equal(s.withdrawn.length, 0);
});

// #4 — circuit breaker halts sending on a checkpoint and persists across ticks.
test('circuit breaker trips on a checkpoint and stays active', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const config = testConfig({ safety: { breakerCooldownHours: 12 } });
  const h = buildHarness({ clock, config, clientOpts: { blocked: true } });
  const [id] = seedLeads(h.leads, 1);
  h.leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, clock().toISOString());

  const s1 = await h.sequencer.tick();
  assert.match(s1.skipped, /circuit-breaker tripped/);
  assert.ok(h.db.lastEventTime('circuit_break'), 'the trip is persisted');
  assert.equal(s1.sent, null, 'nothing was sent');

  // A later tick (within cooldown) stays dark even before re-touching LinkedIn.
  clock.advanceHours(1);
  const s2 = await h.sequencer.tick();
  assert.match(s2.skipped, /circuit-breaker active/);

  // Only one trip event is logged per cooldown window.
  const trips = h.db.countEventsSince('circuit_break', 24 * 3600 * 1000, clock());
  assert.equal(trips, 1);
});

// #8 — Claude output is sanitized (preamble / quotes / fences stripped).
test('sanitize strips preambles, wrapping quotes, and code fences', () => {
  assert.equal(sanitize('"Hi Jane, nice work."'), 'Hi Jane, nice work.');
  assert.equal(sanitize("Sure, here's the message:\nHi Jane, nice work."), 'Hi Jane, nice work.');
  assert.equal(sanitize('```\nHi Jane\n```'), 'Hi Jane');
  assert.equal(sanitize('Here is your note:\nhello there'), 'hello there');
  // Leaves a clean message untouched.
  assert.equal(sanitize('Hi Jane, congrats on the launch.'), 'Hi Jane, congrats on the launch.');
});
