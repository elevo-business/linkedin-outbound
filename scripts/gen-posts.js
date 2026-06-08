#!/usr/bin/env node
// Generate N posts for a magnet (cycling through the hook variants) and store
// them as drafts. Schedule them with --schedule to spread over the coming days.
//   node scripts/gen-posts.js <magnetId> [count] [--schedule]

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { Campaigns } from '../src/db/campaigns.js';
import { Posts, POST_STATUS } from '../src/db/posts.js';
import { ContentGenerator, POST_HOOKS } from '../src/inbound/contentGenerator.js';
import { pickHook } from '../src/inbound/learning.js';
import { createImageClient, generatePostImage } from '../src/image/index.js';

const DAY = 24 * 3600 * 1000;

async function main() {
  const args = process.argv.slice(2);
  const schedule = args.includes('--schedule');
  const publishNow = args.includes('--now'); // schedule at current time -> due immediately
  const learn = args.includes('--learn'); // pick hooks by past performance (bandit)
  const withImage = args.includes('--image'); // also generate a post image
  const positional = args.filter((a) => !a.startsWith('--'));
  const magnetId = Number(positional[0]);
  const count = Number(positional[1] || 3);
  if (!magnetId) {
    console.error('Usage: node scripts/gen-posts.js <magnetId> [count] [--schedule]');
    process.exit(1);
  }

  const config = loadConfig();
  const db = new Db(config.dbPath);
  const magnets = new Magnets(db);
  const campaigns = new Campaigns(db);
  const posts = new Posts(db);
  const gen = new ContentGenerator(config, console.log);

  const magnet = magnets.byId(magnetId);
  if (!magnet) {
    console.error(`No magnet #${magnetId}. Run gen-magnet.js first or check the id.`);
    process.exit(1);
  }
  // Inherit the campaign (ICP/voice/trigger) from the magnet, if any.
  const campaign = magnet.campaign_id ? campaigns.byId(magnet.campaign_id) : null;
  const image = withImage ? await createImageClient(config, console.log) : null;

  for (let i = 0; i < count; i++) {
    const hook = learn ? pickHook(db, POST_HOOKS) : POST_HOOKS[i % POST_HOOKS.length];
    const post = await gen.post(magnet, hook, campaign);
    const willSchedule = schedule || publishNow;
    const scheduledAt = publishNow
      ? new Date().toISOString()
      : schedule
        ? new Date(Date.now() + (i + 1) * DAY).toISOString()
        : null;
    const id = posts.create({
      campaign_id: campaign?.id ?? null,
      magnet_id: magnetId,
      status: willSchedule ? POST_STATUS.SCHEDULED : POST_STATUS.DRAFT,
      body: post.body,
      hook: post.hook,
      trigger_word: post.trigger_word,
      scheduled_at: scheduledAt,
    });
    console.log(`\nPost #${id} [${hook}]${scheduledAt ? ` scheduled ${scheduledAt}` : ' (draft)'}`);
    console.log(post.body);

    if (image?.enabled) {
      const r = await generatePostImage({ image, contentGenerator: gen, config, post: posts.byId(id), magnet, campaign });
      if (r.ok) {
        posts.setImage(id, r.path, r.brief);
        console.log(`  🖼  image: ${r.path}`);
      } else if (!r.skipped) {
        console.log(`  ⚠️  image failed: ${r.error}`);
      }
    }
  }
  console.log(`\nGenerated ${count} post(s) for magnet "${magnet.name}".`);
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
