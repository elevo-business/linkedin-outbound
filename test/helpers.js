// Shared test scaffolding: in-memory DB + wired sequencer with a controllable
// clock and a MockClient. No .env, no network, no real LinkedIn.

process.env.LO_NO_DOTENV = '1';

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Leads } from '../src/db/leads.js';
import { MockClient } from '../src/linkedin/MockClient.js';
import { Personalizer } from '../src/ai/personalizer.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Notifier } from '../src/notify/notifier.js';
import { Sequencer } from '../src/core/sequencer.js';

export function makeClock(iso = '2026-06-01T10:00:00Z') {
  const state = { now: new Date(iso) };
  const clock = () => state.now;
  clock.set = (v) => { state.now = new Date(v); };
  clock.advanceDays = (d) => { state.now = new Date(state.now.getTime() + d * 86400000); };
  clock.advanceHours = (h) => { state.now = new Date(state.now.getTime() + h * 3600000); };
  return clock;
}

export function testConfig(overrides = {}) {
  return loadConfig({
    warmupUntil: '2000-01-01',
    work: { hoursStart: 0, hoursEnd: 24, days: [1, 2, 3, 4, 5, 6, 7] },
    limits: { invitesPerDay: 100, invitesPerWeek: 1000, invitesPerHour: 100, messagesPerDay: 100, rampUpDays: 0, rampUpStartInvites: 5 },
    sequence: { daysBeforeFirstDm: 1, daysBeforeFollowup1: 3, daysBeforeFollowup2: 4, daysBeforeDone: 5 },
    ...overrides,
  });
}

export function buildHarness({ config = testConfig(), clientOpts = {}, clock = makeClock() } = {}) {
  const db = new Db(':memory:');
  const leads = new Leads(db);
  const client = new MockClient({ logger: () => {}, ...clientOpts });
  const personalizer = new Personalizer(config, () => {});
  const rateLimiter = new RateLimiter(db, config);
  const notifier = new Notifier({ notify: { driver: 'console' } }, () => {});
  const sequencer = new Sequencer({ db, leads, client, personalizer, rateLimiter, notifier, config, clock, logger: () => {} });
  return { db, leads, client, personalizer, rateLimiter, notifier, sequencer, config, clock };
}

export function seedLeads(leads, n, prefix = 'p') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      leads.upsert({ linkedin_url: `https://linkedin.com/in/${prefix}${i}`, name: `Person ${i}`, company: `Co${i}` })
    );
  }
  return ids;
}
