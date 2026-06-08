#!/usr/bin/env node
// Generate a lead magnet and store it.
//   node scripts/gen-magnet.js "cold email deliverability"
//   node scripts/gen-magnet.js "cold email deliverability" --campaign 1
//
// With --campaign, the magnet uses that campaign's ICP/voice/trigger/delivery
// (dynamic). Without it, the INBOUND_* env defaults apply. Uses Claude when
// PERSONALIZER=claude-cli, templates otherwise.

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { Campaigns } from '../src/db/campaigns.js';
import { ContentGenerator } from '../src/inbound/contentGenerator.js';

async function main() {
  const args = process.argv.slice(2);
  const campIdx = args.indexOf('--campaign');
  const campRef = campIdx !== -1 ? args[campIdx + 1] : null;
  const topic = args.filter((a, i) => !a.startsWith('--') && i !== campIdx + 1).join(' ').trim();

  const config = loadConfig();
  const db = new Db(config.dbPath);
  const magnets = new Magnets(db);
  const campaigns = new Campaigns(db);
  const gen = new ContentGenerator(config, console.log);

  let campaign = null;
  if (campRef) {
    campaign = campaigns.resolve(campRef);
    if (!campaign) {
      console.error(`No campaign "${campRef}". List them with: npm run campaign -- list`);
      process.exit(1);
    }
  }

  const defaultTopic = (campaign?.topics || config.inbound.topics.join(',') || '').split(',')[0].trim();
  if (!topic && !defaultTopic) {
    console.error('Usage: node scripts/gen-magnet.js "<topic>" [--campaign <id|name>]');
    process.exit(1);
  }

  const magnet = await gen.magnet(topic || defaultTopic, campaign);
  const id = magnets.create({
    ...magnet,
    campaign_id: campaign?.id ?? null,
    delivery: campaign?.delivery ?? config.inbound.deliveryMode,
  });
  const saved = magnets.byId(id);

  console.log(`\nCreated magnet #${id} (${saved.slug})${campaign ? ` in campaign "${campaign.name}"` : ''}`);
  console.log(`  name: ${saved.name}`);
  console.log(`  cta:  ${saved.cta}`);
  console.log(`  delivery: ${saved.delivery}`);
  console.log(`  capture link: ${config.inbound.captureBaseUrl}/m/${saved.slug}`);
  console.log(`\n--- body ---\n${saved.body}\n`);
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
