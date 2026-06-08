#!/usr/bin/env node
// Entry point. Wires config -> db -> client -> personalizer -> sequencer.
//   node src/runner.js --once     run a single tick and exit (good for cron)
//   node src/runner.js            run continuously with human-like jittered delays

import { loadConfig } from './config.js';
import { Db } from './db/db.js';
import { Leads } from './db/leads.js';
import { createClient } from './linkedin/index.js';
import { Personalizer } from './ai/personalizer.js';
import { RateLimiter } from './core/rateLimiter.js';
import { Notifier } from './notify/notifier.js';
import { Sequencer } from './core/sequencer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export async function buildSequencer(config, logger = console.log) {
  const db = new Db(config.dbPath);
  const leads = new Leads(db);
  const client = await createClient(config, logger);
  const personalizer = new Personalizer(config, logger);
  const rateLimiter = new RateLimiter(db, config);
  const notifier = new Notifier(config, logger);
  const sequencer = new Sequencer({ db, leads, client, personalizer, rateLimiter, notifier, config, logger });
  return { db, client, sequencer };
}

function describe(summary) {
  if (summary.skipped) return `skipped: ${summary.skipped}`;
  const parts = [];
  if (summary.replies.length) parts.push(`replies=${summary.replies.length}`);
  if (summary.connected.length) parts.push(`accepted=${summary.connected.length}`);
  if (summary.expired.length) parts.push(`done=${summary.expired.length}`);
  if (summary.sent) parts.push(`sent=${summary.sent.action}#${summary.sent.leadId}`);
  return parts.length ? parts.join(' ') : 'nothing to do';
}

async function main() {
  const once = process.argv.includes('--once');
  const config = loadConfig();
  const { db, client, sequencer } = await buildSequencer(config);

  const login = await client.login();
  if (!login.ok) {
    console.error(`Login failed: ${login.error}`);
    await client.close();
    db.close();
    process.exit(1);
  }

  if (once) {
    const summary = await sequencer.tick();
    console.log(`[tick] ${describe(summary)}`);
    await client.close();
    db.close();
    return;
  }

  console.log(`Running loop (driver=${config.driver}). Ctrl+C to stop.`);
  let stop = false;
  process.on('SIGINT', () => {
    console.log('\nStopping after current tick…');
    stop = true;
  });

  while (!stop) {
    const summary = await sequencer.tick();
    console.log(`[${new Date().toLocaleTimeString()}] ${describe(summary)}`);
    if (summary.skipped === 'off-hours' || summary.skipped?.startsWith('warmup')) {
      await sleep(rand(10, 20) * 60 * 1000); // idle: re-check every ~15 min
    } else {
      await sleep(rand(config.delays.minSeconds, config.delays.maxSeconds) * 1000);
    }
  }

  await client.close();
  db.close();
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
