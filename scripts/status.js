#!/usr/bin/env node
// Show pipeline status: counts per stage, today's activity, current limits.
//   node scripts/status.js

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Leads } from '../src/db/leads.js';
import { Posts } from '../src/db/posts.js';
import { Engagements } from '../src/db/engagements.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { hookStats } from '../src/inbound/learning.js';

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;

const config = loadConfig();
const db = new Db(config.dbPath);
const leads = new Leads(db);
const rate = new RateLimiter(db, config);
const now = new Date();

const counts = leads.counts();
const order = ['new', 'invited', 'connected', 'messaged', 'followup_1', 'followup_2', 'replied', 'done', 'withdrawn', 'failed'];

console.log('\n=== Pipeline ===');
for (const s of order) console.log(`  ${s.padEnd(12)} ${counts[s] || 0}`);

const MONTH = 30 * DAY;
const notedMonth = db.countEventsSince('invite_sent', MONTH, now, 'noted');

console.log('\n=== Activity ===');
console.log(`  invites today   ${db.countEventsSince('invite_sent', DAY, now)} / ${rate.effectiveInvitesPerDay(now)} (effective)`);
console.log(`  invites week    ${db.countEventsSince('invite_sent', WEEK, now)} / ${config.limits.invitesPerWeek}`);
console.log(`  noted invites   ${notedMonth} / ${config.invites.maxNotedPerMonth || '∞'} (last 30d)`);
console.log(`  messages today  ${db.countEventsSince('message_sent', DAY, now)} / ${config.limits.messagesPerDay}`);
if (config.email.channel !== 'none') {
  const enrolled = db.get(`SELECT COUNT(*) AS n FROM leads WHERE email_enrolled_at IS NOT NULL`).n;
  console.log(`  email enrolled  ${enrolled} (fallback channel)`);
}

console.log('\n=== Config ===');
console.log(`  driver          ${config.driver}`);
console.log(`  email channel   ${config.email.channel}${config.email.channel !== 'none' ? ` (campaign ${config.email.instantly.campaignId || '—'})` : ''}`);
console.log(`  warmup until    ${config.warmupUntil}  (${now < new Date(config.warmupUntil) ? 'BLOCKING — no sends' : 'passed — active'})`);
console.log(`  work hours      ${config.work.hoursStart}:00–${config.work.hoursEnd}:00, days ${config.work.days.join(',')}`);
console.log(`  within window   ${rate.withinWorkHours(now)}`);

const lastBreak = db.lastEventTime('circuit_break');
const breakerActive =
  lastBreak && now.getTime() - new Date(lastBreak).getTime() < config.safety.breakerCooldownHours * 3600 * 1000;
console.log(`  circuit breaker ${breakerActive ? `🛑 ACTIVE (last trip ${lastBreak}) — sending paused` : 'ok'}`);

// ---- Inbound (content-driven) engine ----
const posts = new Posts(db);
const engagements = new Engagements(db);
const pc = posts.counts();
const ec = engagements.counts();
const magnetCount = db.get(`SELECT COUNT(*) AS n FROM magnets`).n;
const hasInbound = magnetCount || Object.keys(pc).length || Object.keys(ec).length;

if (hasInbound) {
  console.log('\n=== Inbound: posts ===');
  for (const s of ['draft', 'scheduled', 'published', 'failed']) console.log(`  ${s.padEnd(12)} ${pc[s] || 0}`);

  console.log('\n=== Inbound: engagements ===');
  for (const s of ['engaged', 'dm_sent', 'delivered', 'replied', 'done', 'failed']) console.log(`  ${s.padEnd(12)} ${ec[s] || 0}`);
  console.log(`  magnets       ${magnetCount}`);
  console.log(`  clicks (30d)  ${db.countEventsSince('magnet_click', MONTH, now)}`);
  console.log(`  captures (30d)${db.countEventsSince('email_captured', MONTH, now)}`);
  console.log(`  crm created   ${db.countEventsSince('crm_created', MONTH, now)} (30d, provider: ${config.crm.provider})`);

  const stats = hookStats(db);
  const hooks = Object.keys(stats);
  if (hooks.length) {
    console.log('\n=== Inbound: hook performance (learning) ===');
    for (const h of hooks.sort((a, b) => stats[b].rate - stats[a].rate)) {
      console.log(`  ${h.padEnd(12)} ${stats[h].engagements}/${stats[h].posts} posts  → ${stats[h].rate.toFixed(2)} eng/post`);
    }
  }
}
console.log('');

db.close();
