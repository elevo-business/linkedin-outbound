import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { Leads, STATUS } from '../src/db/leads.js';

test('upsert inserts and dedupes by linkedin_url', () => {
  const db = new Db(':memory:');
  const leads = new Leads(db);
  const id1 = leads.upsert({ linkedin_url: 'https://x/in/a', name: 'A' });
  const id2 = leads.upsert({ linkedin_url: 'https://x/in/a', company: 'ACo' });
  assert.equal(id1, id2, 'same url -> same row');
  const row = leads.byId(id1);
  assert.equal(row.name, 'A');
  assert.equal(row.company, 'ACo', 'upsert merges new fields');
  assert.equal(row.status, STATUS.NEW);
  db.close();
});

test('counts groups by status', () => {
  const db = new Db(':memory:');
  const leads = new Leads(db);
  const a = leads.upsert({ linkedin_url: 'https://x/in/a' });
  leads.upsert({ linkedin_url: 'https://x/in/b' });
  leads.setStatus(a, STATUS.INVITED, { stampColumn: 'invited_at' });
  const counts = leads.counts();
  assert.equal(counts[STATUS.NEW], 1);
  assert.equal(counts[STATUS.INVITED], 1);
  db.close();
});

test('setStatus stamps the given column and updates timestamp', () => {
  const db = new Db(':memory:');
  const leads = new Leads(db);
  const id = leads.upsert({ linkedin_url: 'https://x/in/a' });
  leads.setStatus(id, STATUS.INVITED, { stampColumn: 'invited_at' }, '2026-06-01T00:00:00Z');
  const row = leads.byId(id);
  assert.equal(row.status, STATUS.INVITED);
  assert.equal(row.invited_at, '2026-06-01T00:00:00Z');
  db.close();
});

test('event counting windows work', () => {
  const db = new Db(':memory:');
  const now = new Date('2026-06-01T12:00:00Z');
  db.logEvent(1, 'invite_sent', null, new Date('2026-06-01T11:30:00Z').toISOString()); // 30m ago
  db.logEvent(1, 'invite_sent', null, new Date('2026-05-30T12:00:00Z').toISOString()); // 2d ago
  assert.equal(db.countEventsSince('invite_sent', 3600 * 1000, now), 1, 'last hour');
  assert.equal(db.countEventsSince('invite_sent', 24 * 3600 * 1000, now), 1, 'last day');
  assert.equal(db.countEventsSince('invite_sent', 7 * 24 * 3600 * 1000, now), 2, 'last week');
  db.close();
});
