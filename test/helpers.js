// Shared test scaffolding: in-memory DB + wired sequencer with a controllable
// clock and a MockClient. No .env, no network, no real LinkedIn.

process.env.LO_NO_DOTENV = '1';

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Leads } from '../src/db/leads.js';
import { MockClient } from '../src/linkedin/MockClient.js';
import { MockEmailClient } from '../src/email/MockEmailClient.js';
import { NullEmailClient } from '../src/email/EmailClient.js';
import { Personalizer } from '../src/ai/personalizer.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { Notifier } from '../src/notify/notifier.js';
import { Sequencer } from '../src/core/sequencer.js';
import { Magnets } from '../src/db/magnets.js';
import { Posts } from '../src/db/posts.js';
import { Engagements } from '../src/db/engagements.js';
import { InboundSequencer } from '../src/inbound/inboundSequencer.js';
import { MockCrmClient } from '../src/crm/MockCrmClient.js';
import { NullCrmClient } from '../src/crm/CrmClient.js';

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

export function buildHarness({ config = testConfig(), clientOpts = {}, emailClientOpts = null, clock = makeClock() } = {}) {
  const db = new Db(':memory:');
  const leads = new Leads(db);
  const client = new MockClient({ logger: () => {}, ...clientOpts });
  // Opt into the email channel only when a test passes emailClientOpts.
  const email = emailClientOpts ? new MockEmailClient({ logger: () => {}, ...emailClientOpts }) : new NullEmailClient();
  const personalizer = new Personalizer(config, () => {});
  const rateLimiter = new RateLimiter(db, config);
  const notifier = new Notifier({ notify: { driver: 'console' } }, () => {});
  const sequencer = new Sequencer({ db, leads, client, email, personalizer, rateLimiter, notifier, config, clock, logger: () => {} });
  return { db, leads, client, email, personalizer, rateLimiter, notifier, sequencer, config, clock };
}

export function buildInboundHarness({ config = testConfig(), clientOpts = {}, crmClientOpts = null, clock = makeClock() } = {}) {
  const db = new Db(':memory:');
  const magnets = new Magnets(db);
  const posts = new Posts(db);
  const engagements = new Engagements(db);
  const client = new MockClient({ logger: () => {}, ...clientOpts });
  const crm = crmClientOpts ? new MockCrmClient({ logger: () => {}, ...crmClientOpts }) : new NullCrmClient();
  const rateLimiter = new RateLimiter(db, config);
  const notifier = new Notifier({ notify: { driver: 'console' } }, () => {});
  const sequencer = new InboundSequencer({ db, magnets, posts, engagements, client, crm, rateLimiter, notifier, config, clock, logger: () => {} });
  return { db, magnets, posts, engagements, client, crm, rateLimiter, notifier, sequencer, config, clock };
}

export function seedLeads(leads, n, prefix = 'p', { withEmail = false } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      leads.upsert({
        linkedin_url: `https://linkedin.com/in/${prefix}${i}`,
        name: `Person ${i}`,
        company: `Co${i}`,
        email: withEmail ? `person${i}@example.com` : null,
      })
    );
  }
  return ids;
}
