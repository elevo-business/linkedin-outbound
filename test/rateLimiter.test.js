import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { testConfig } from './helpers.js';

function dbWithInvites(times) {
  const db = new Db(':memory:');
  for (const t of times) db.logEvent(1, 'invite_sent', null, t);
  return db;
}

test('daily invite cap blocks once reached', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const db = dbWithInvites([
    '2026-06-01T09:00:00Z',
    '2026-06-01T10:00:00Z',
  ]);
  const cfg = testConfig({ limits: { invitesPerDay: 2, invitesPerWeek: 100, invitesPerHour: 100, messagesPerDay: 100, rampUpDays: 0, rampUpStartInvites: 1 } });
  const rate = new RateLimiter(db, cfg);
  assert.equal(rate.canInvite(now).ok, false);
  db.close();
});

test('hourly invite cap blocks bursts', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const db = dbWithInvites(['2026-06-01T11:30:00Z']);
  const cfg = testConfig({ limits: { invitesPerDay: 100, invitesPerWeek: 100, invitesPerHour: 1, messagesPerDay: 100, rampUpDays: 0, rampUpStartInvites: 1 } });
  const rate = new RateLimiter(db, cfg);
  assert.equal(rate.canInvite(now).ok, false);
  db.close();
});

test('ramp-up grows the daily cap over time', () => {
  const db = new Db(':memory:');
  // First invite ever at day 0.
  db.logEvent(1, 'invite_sent', null, '2026-06-01T09:00:00Z');
  const cfg = testConfig({ limits: { invitesPerDay: 15, invitesPerWeek: 100, invitesPerHour: 100, messagesPerDay: 100, rampUpDays: 10, rampUpStartInvites: 5 } });
  const rate = new RateLimiter(db, cfg);
  const day0 = rate.effectiveInvitesPerDay(new Date('2026-06-01T10:00:00Z'));
  const day5 = rate.effectiveInvitesPerDay(new Date('2026-06-06T10:00:00Z'));
  const day20 = rate.effectiveInvitesPerDay(new Date('2026-06-21T10:00:00Z'));
  assert.equal(day0, 5, 'starts at floor');
  assert.ok(day5 > day0 && day5 < 15, 'grows in the middle');
  assert.equal(day20, 15, 'caps at the configured max');
  db.close();
});

test('work hours gate respects window and days', () => {
  const db = new Db(':memory:');
  const cfg = testConfig({ work: { hoursStart: 9, hoursEnd: 17, days: [1, 2, 3, 4, 5] } });
  const rate = new RateLimiter(db, cfg);
  // 2026-06-01 is a Monday. Local hours used; build via local Date components.
  assert.equal(rate.withinWorkHours(new Date(2026, 5, 1, 10, 0)), true, 'Mon 10:00');
  assert.equal(rate.withinWorkHours(new Date(2026, 5, 1, 8, 0)), false, 'Mon 08:00 too early');
  assert.equal(rate.withinWorkHours(new Date(2026, 5, 1, 18, 0)), false, 'Mon 18:00 too late');
  assert.equal(rate.withinWorkHours(new Date(2026, 5, 6, 10, 0)), false, 'Sat blocked');
  db.close();
});
