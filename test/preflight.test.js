import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { Magnets } from '../src/db/magnets.js';
import { Posts, POST_STATUS } from '../src/db/posts.js';
import { preflightChecks, summarize } from '../src/preflight.js';
import { testConfig } from './helpers.js';

const find = (checks, name) => checks.find((c) => c.name === name);

function liveConfig(over = {}) {
  return testConfig({
    driver: 'unipile',
    unipile: { dsn: 'https://x', apiKey: 'k', accountId: 'a' },
    warmupUntil: '2000-01-01',
    work: { hoursStart: 0, hoursEnd: 24, days: [1, 2, 3, 4, 5, 6, 7] },
    personalizer: { mode: 'claude-cli' },
    inbound: { captureBaseUrl: 'https://magnets.example.com', deliveryMode: 'dm', triggerWord: 'guide' },
    crm: { provider: 'pipedrive', pipedrive: { apiToken: 'tok', baseUrl: 'https://api.pipedrive.com/v1' } },
    ...over,
  });
}

function readyDb() {
  const db = new Db(':memory:');
  const mid = new Magnets(db).create({ name: 'The Guide', body: 'b' });
  new Posts(db).create({ magnet_id: mid, status: POST_STATUS.SCHEDULED, body: 'x', hook: 'listicle', trigger_word: 'guide', scheduled_at: '2000-01-01T00:00:00Z' });
  return db;
}

test('preflight: fully configured setup is READY', async () => {
  const checks = await preflightChecks(liveConfig(), readyDb(), { claudeAvailable: true });
  const { ready, blocks } = summarize(checks);
  assert.equal(blocks, 0, JSON.stringify(checks.filter((c) => c.level === 'block')));
  assert.equal(ready, true);
});

test('preflight: blocks on mock driver, warmup, localhost URL, no content', async () => {
  const config = liveConfig({
    driver: 'mock',
    warmupUntil: '2999-01-01',
    inbound: { captureBaseUrl: 'http://localhost:3000' },
  });
  const checks = await preflightChecks(config, new Db(':memory:'), {});
  assert.equal(find(checks, 'LinkedIn driver').level, 'block');
  assert.equal(find(checks, 'Warmup passed').level, 'block');
  assert.equal(find(checks, 'Capture base URL public').level, 'block');
  assert.equal(find(checks, 'A lead magnet exists').level, 'block');
  assert.equal(find(checks, 'A post is scheduled').level, 'block');
  assert.equal(summarize(checks).ready, false);
});

test('preflight: missing unipile creds blocks; missing pipedrive token blocks', async () => {
  const config = liveConfig({ unipile: { dsn: '', apiKey: '', accountId: '' }, crm: { provider: 'pipedrive', pipedrive: { apiToken: '' } } });
  const checks = await preflightChecks(config, readyDb(), { claudeAvailable: true });
  assert.equal(find(checks, 'Unipile credentials').level, 'block');
  assert.equal(find(checks, 'Pipedrive token').level, 'block');
});

test('preflight: a scheduled-but-future post warns "not due now"', async () => {
  const db = new Db(':memory:');
  const mid = new Magnets(db).create({ name: 'M', body: 'b' });
  new Posts(db).create({ magnet_id: mid, status: POST_STATUS.SCHEDULED, body: 'x', hook: 'q', trigger_word: 'guide', scheduled_at: '2999-01-01T00:00:00Z' });
  const checks = await preflightChecks(liveConfig(), db, { claudeAvailable: true });
  assert.equal(find(checks, 'A post is scheduled').level, 'ok');
  assert.equal(find(checks, 'A post is due now').level, 'warn');
});
