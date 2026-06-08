#!/usr/bin/env node
// Generate a lead magnet and store it.
//   node scripts/gen-magnet.js "cold email deliverability"
//
// Uses Claude (PERSONALIZER=claude-cli) for the body, templates otherwise.

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { ContentGenerator } from '../src/inbound/contentGenerator.js';

async function main() {
  const topic = process.argv.slice(2).join(' ').trim();
  const config = loadConfig();
  if (!topic && !config.inbound.topics.length) {
    console.error('Usage: node scripts/gen-magnet.js "<topic>"   (or set INBOUND_TOPICS)');
    process.exit(1);
  }
  const db = new Db(config.dbPath);
  const magnets = new Magnets(db);
  const gen = new ContentGenerator(config, console.log);

  const magnet = await gen.magnet(topic || config.inbound.topics[0]);
  const id = magnets.create(magnet);
  const saved = magnets.byId(id);

  console.log(`\nCreated magnet #${id} (${saved.slug})`);
  console.log(`  name: ${saved.name}`);
  console.log(`  cta:  ${saved.cta}`);
  console.log(`  capture link: ${config.inbound.captureBaseUrl}/m/${saved.slug}`);
  console.log(`\n--- body ---\n${saved.body}\n`);
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
