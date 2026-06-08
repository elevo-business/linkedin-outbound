#!/usr/bin/env node
// Manage campaigns (dynamic ICP/topic/voice bundles). Magnets & posts attach to a
// campaign, so you can run many ICPs in parallel — no single global ICP.
//
//   node scripts/campaign.js add --name "DACH SaaS" --icp "B2B SaaS founders in DACH" \
//        --topics "outbound,deliverability" --trigger guide --delivery dm \
//        --value-prop "we book demos" --sender-name "Mert" --sender-role "Founder"
//   node scripts/campaign.js list
//   node scripts/campaign.js pause <id>
//   node scripts/campaign.js activate <id>

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Campaigns } from '../src/db/campaigns.js';

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const db = new Db(config.dbPath);
  const campaigns = new Campaigns(db);

  if (cmd === 'add') {
    const f = parseFlags(rest);
    if (!f.name) {
      console.error('--name is required');
      process.exit(1);
    }
    const id = campaigns.create({
      name: f.name,
      icp: f.icp ?? null,
      topics: f.topics ?? null,
      trigger_word: f.trigger ?? config.inbound.triggerWord,
      delivery: f.delivery ?? config.inbound.deliveryMode,
      value_prop: f['value-prop'] ?? null,
      sender_name: f['sender-name'] ?? null,
      sender_role: f['sender-role'] ?? null,
    });
    const c = campaigns.byId(id);
    console.log(`Created campaign #${id} "${c.name}"`);
    console.log(`  icp: ${c.icp}\n  topics: ${c.topics}\n  trigger: ${c.trigger_word}\n  delivery: ${c.delivery}`);
    console.log(`\nNext: npm run gen-magnet -- "<topic>" --campaign ${id}`);
  } else if (cmd === 'list') {
    const all = campaigns.all();
    if (!all.length) return console.log('No campaigns yet. Add one with `campaign.js add --name ...`.');
    for (const c of all) {
      console.log(`#${c.id} [${c.status}] ${c.name}`);
      console.log(`    icp: ${c.icp || '—'} | trigger: ${c.trigger_word || '—'} | delivery: ${c.delivery} | topics: ${c.topics || '—'}`);
    }
  } else if (cmd === 'pause' || cmd === 'activate') {
    const id = Number(rest[0]);
    if (!id) {
      console.error(`Usage: campaign.js ${cmd} <id>`);
      process.exit(1);
    }
    campaigns.setStatus(id, cmd === 'pause' ? 'paused' : 'active');
    console.log(`Campaign #${id} -> ${cmd === 'pause' ? 'paused' : 'active'}`);
  } else {
    console.error('Usage: campaign.js <add|list|pause|activate> ...');
    process.exit(1);
  }
  db.close();
}

main();
