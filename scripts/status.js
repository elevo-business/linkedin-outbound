#!/usr/bin/env node
// Show pipeline status: counts per stage, today's activity, current limits.
//   node scripts/status.js

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Leads } from '../src/db/leads.js';
import { RateLimiter } from '../src/core/rateLimiter.js';

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;

const config = loadConfig();
const db = new Db(config.dbPath);
const leads = new Leads(db);
const rate = new RateLimiter(db, config);
const now = new Date();

const counts = leads.counts();
const order = ['new', 'invited', 'connected', 'messaged', 'followup_1', 'followup_2', 'replied', 'done', 'failed'];

console.log('\n=== Pipeline ===');
for (const s of order) console.log(`  ${s.padEnd(12)} ${counts[s] || 0}`);

console.log('\n=== Activity ===');
console.log(`  invites today   ${db.countEventsSince('invite_sent', DAY, now)} / ${rate.effectiveInvitesPerDay(now)} (effective)`);
console.log(`  invites week    ${db.countEventsSince('invite_sent', WEEK, now)} / ${config.limits.invitesPerWeek}`);
console.log(`  messages today  ${db.countEventsSince('message_sent', DAY, now)} / ${config.limits.messagesPerDay}`);

console.log('\n=== Config ===');
console.log(`  driver          ${config.driver}`);
console.log(`  warmup until    ${config.warmupUntil}  (${now < new Date(config.warmupUntil) ? 'BLOCKING — no sends' : 'passed — active'})`);
console.log(`  work hours      ${config.work.hoursStart}:00–${config.work.hoursEnd}:00, days ${config.work.days.join(',')}`);
console.log(`  within window   ${rate.withinWorkHours(now)}`);
console.log('');

db.close();
