import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { Posts } from '../src/db/posts.js';
import { ContentGenerator } from '../src/inbound/contentGenerator.js';
import { MockImageClient } from '../src/image/MockImageClient.js';
import { createImageClient, generatePostImage } from '../src/image/index.js';
import { magnetToPdf } from '../src/inbound/magnetPdf.js';
import { testConfig } from './helpers.js';

test('image factory honours IMAGE_PROVIDER', async () => {
  assert.equal((await createImageClient(testConfig())).enabled, false); // none
  assert.equal((await createImageClient(testConfig({ image: { provider: 'mock' } }))).enabled, true);
  await assert.rejects(() => createImageClient(testConfig({ image: { provider: 'bogus' } })), /Unknown IMAGE_PROVIDER/);
});

test('generatePostImage briefs + renders + returns a path; setImage persists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-img-'));
  const config = testConfig({ image: { provider: 'mock', dir } });
  const db = new Db(':memory:');
  const mid = new Magnets(db).create({ name: 'The Guide', body: 'b', description: 'a guide' });
  const posts = new Posts(db);
  const pid = posts.create({ magnet_id: mid, body: 'great post', hook: 'listicle' });

  const image = new MockImageClient();
  const gen = new ContentGenerator(config, () => {});
  const r = await generatePostImage({ image, contentGenerator: gen, config, post: posts.byId(pid), magnet: new Magnets(db).byId(mid), campaign: null });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.path), 'image file written');
  assert.ok(r.brief && r.brief.length > 0, 'a brief was produced');

  posts.setImage(pid, r.path, r.brief);
  assert.equal(posts.byId(pid).image_path, r.path);
  assert.ok(image.actions.some((a) => a.type === 'generate'));
});

test('NullImageClient (provider none) generates nothing', async () => {
  const config = testConfig(); // provider none
  const image = await createImageClient(config);
  const r = await generatePostImage({ image, contentGenerator: new ContentGenerator(config, () => {}), config, post: { id: 1 }, magnet: null, campaign: null });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});

test('magnetToPdf produces a valid multi-section PDF buffer', () => {
  const pdf = magnetToPdf({
    title: 'The Outbound Playbook',
    author: 'Mert, Founder',
    markdown: '# Intro\n\nSome text here.\n\n## Steps\n\n1. Do this\n2. Then that\n- a bullet\n\n' + 'word '.repeat(1500),
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 500);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /%%EOF$/);
  // long content forced more than one page
  assert.match(pdf.toString('latin1'), /\/Count [2-9]/);
});
