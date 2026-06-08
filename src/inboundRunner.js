#!/usr/bin/env node
// Inbound entry point. Wires config -> db -> repos -> client -> InboundSequencer.
//   node src/inboundRunner.js --once    one tick (good for cron)
//   node src/inboundRunner.js           continuous loop with human-like delays

import { loadConfig } from './config.js';
import { Db } from './db/db.js';
import { Magnets } from './db/magnets.js';
import { Posts } from './db/posts.js';
import { Engagements } from './db/engagements.js';
import { createClient } from './linkedin/index.js';
import { RateLimiter } from './core/rateLimiter.js';
import { Notifier } from './notify/notifier.js';
import { InboundSequencer } from './inbound/inboundSequencer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export async function buildInbound(config, logger = console.log) {
  const db = new Db(config.dbPath);
  const magnets = new Magnets(db);
  const posts = new Posts(db);
  const engagements = new Engagements(db);
  const client = await createClient(config, logger);
  const rateLimiter = new RateLimiter(db, config);
  const notifier = new Notifier(config, logger);
  const sequencer = new InboundSequencer({ db, magnets, posts, engagements, client, rateLimiter, notifier, config, logger });
  return { db, client, sequencer };
}

function describe(s) {
  if (s.skipped) return `skipped: ${s.skipped}`;
  const parts = [];
  if (s.published.length) parts.push(`published=${s.published.length}`);
  if (s.engaged.length) parts.push(`engaged=${s.engaged.length}`);
  if (s.accepted.length) parts.push(`accepted=${s.accepted.length}`);
  if (s.delivered.length) parts.push(`delivered=${s.delivered.length}`);
  if (s.replies.length) parts.push(`replies=${s.replies.length}`);
  return parts.length ? parts.join(' ') : 'nothing to do';
}

async function main() {
  const once = process.argv.includes('--once');
  const config = loadConfig();
  const { db, client, sequencer } = await buildInbound(config);

  const login = await client.login();
  if (!login.ok) {
    console.error(`Login failed: ${login.error}`);
    await client.close();
    db.close();
    process.exit(1);
  }

  if (once) {
    const summary = await sequencer.tick();
    console.log(`[inbound] ${describe(summary)}`);
    await client.close();
    db.close();
    return;
  }

  console.log(`Running inbound loop (driver=${config.driver}). Ctrl+C to stop.`);
  let stop = false;
  process.on('SIGINT', () => { console.log('\nStopping after current tick…'); stop = true; });

  while (!stop) {
    const summary = await sequencer.tick();
    console.log(`[${new Date().toLocaleTimeString()}] ${describe(summary)}`);
    if (summary.skipped === 'off-hours' || summary.skipped?.startsWith('warmup') || summary.skipped?.startsWith('circuit-breaker')) {
      await sleep(rand(10, 20) * 60 * 1000);
    } else {
      await sleep(rand(config.delays.minSeconds, config.delays.maxSeconds) * 1000);
    }
  }

  await client.close();
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
