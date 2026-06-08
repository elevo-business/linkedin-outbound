import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS } from '../src/db/leads.js';
import { buildHarness, makeClock, seedLeads, testConfig } from './helpers.js';
import { createClient } from '../src/linkedin/index.js';
import { createEmailClient } from '../src/email/index.js';
import { publicIdFromUrl } from '../src/linkedin/UnipileClient.js';

// #9 — an already-connected lead skips the invite and jumps to the DM track.
test('already-connected lead routes straight to connected', async () => {
  const clock = makeClock('2026-06-01T10:00:00Z');
  const h = buildHarness({ clock, clientOpts: { alreadyConnected: () => true } });
  const [id] = seedLeads(h.leads, 1);

  const s = await h.sequencer.tick();
  assert.equal(s.sent.action, 'already_connected');
  assert.equal(h.leads.byId(id).status, STATUS.CONNECTED);
  assert.equal(h.client.actions.length, 0, 'no invite was actually sent');
});

// Unipile: extract the public identifier from a profile URL.
test('publicIdFromUrl parses LinkedIn profile URLs', () => {
  assert.equal(publicIdFromUrl('https://www.linkedin.com/in/jane-doe/'), 'jane-doe');
  assert.equal(publicIdFromUrl('https://linkedin.com/in/john-roe?trk=x'), 'john-roe');
  assert.equal(publicIdFromUrl('https://www.linkedin.com/in/k%C3%A4the/'), 'käthe');
  assert.equal(publicIdFromUrl('https://example.com/notaprofile'), null);
  assert.equal(publicIdFromUrl(''), null);
});

// LinkedIn driver factory recognizes all three drivers and rejects junk.
test('createClient builds the configured driver', async () => {
  const mock = await createClient(testConfig({ driver: 'mock' }), () => {});
  assert.equal(mock.constructor.name, 'MockClient');

  const uni = await createClient(
    testConfig({ driver: 'unipile', unipile: { dsn: 'https://x', apiKey: 'k', accountId: 'a' } }),
    () => {}
  );
  assert.equal(uni.constructor.name, 'UnipileClient');
  assert.equal(uni.isBlocked(), false);

  await assert.rejects(() => createClient(testConfig({ driver: 'bogus' }), () => {}), /Unknown LINKEDIN_DRIVER/);
});

// Email factory: none -> disabled no-op; mock -> enabled; bad value rejected.
test('createEmailClient honours EMAIL_CHANNEL', async () => {
  const none = await createEmailClient(testConfig(), () => {});
  assert.equal(none.enabled, false);

  const mock = await createEmailClient(testConfig({ email: { channel: 'mock' } }), () => {});
  assert.equal(mock.enabled, true);

  await assert.rejects(
    () => createEmailClient(testConfig({ email: { channel: 'bogus' } }), () => {}),
    /Unknown EMAIL_CHANNEL/
  );
});
