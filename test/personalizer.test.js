import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Personalizer, templateNote, templateMessage } from '../src/ai/personalizer.js';
import { testConfig } from './helpers.js';

const cfg = testConfig({ personalizer: { mode: 'template', valueProp: 'I help teams book meetings.', senderName: 'Mert', senderRole: 'Founder' } });

test('connection note stays within LinkedIn 300-char limit and is personalized', () => {
  const note = templateNote({ name: 'Jane Doe', company: 'Acme' }, cfg);
  assert.ok(note.length <= 300, `note length ${note.length}`);
  assert.match(note, /Jane/);
  assert.match(note, /Acme/);
});

test('note handles missing name/company gracefully', () => {
  const note = templateNote({}, cfg);
  assert.ok(note.length > 0 && note.length <= 300);
});

test('messages differ per follow-up step', () => {
  const m1 = templateMessage({ name: 'Jane' }, cfg, 1);
  const m2 = templateMessage({ name: 'Jane' }, cfg, 2);
  const m3 = templateMessage({ name: 'Jane' }, cfg, 3);
  assert.notEqual(m1, m2);
  assert.notEqual(m2, m3);
  assert.match(m1, /Jane/);
});

test('Personalizer in template mode never calls the network', async () => {
  const p = new Personalizer(cfg, () => {});
  const note = await p.note({ name: 'Jane', company: 'Acme' });
  const msg = await p.message({ name: 'Jane' }, 1);
  assert.ok(note.length <= 300);
  assert.ok(msg.length > 0);
});
