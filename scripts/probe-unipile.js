#!/usr/bin/env node
// Validate the Unipile connection and the API field shapes this project's driver
// depends on. Run this where port 16483 (your DSN port) is reachable — e.g. your
// VPS. It is READ-ONLY (no posts, no invites, no messages).
//
//   node scripts/probe-unipile.js                 # account status only
//   node scripts/probe-unipile.js jane-doe        # also resolve a public profile
//
// Paste the (already field-name-only) output back and the driver can be tuned.

import { loadConfig } from '../src/config.js';

const cfg = loadConfig().unipile;
const HAS = (b) => (b ? '✅ FOUND' : '❌ MISSING');

async function req(path) {
  const base = cfg.dsn.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${base}/api/v1${path}`;
  const res = await fetch(url, { headers: { 'X-API-KEY': cfg.apiKey, accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  if (!cfg.dsn || !cfg.apiKey || !cfg.accountId) {
    console.error('Missing UNIPILE_DSN / UNIPILE_API_KEY / UNIPILE_ACCOUNT_ID in .env');
    process.exit(1);
  }
  console.log(`\nProbing ${cfg.dsn} (account ${cfg.accountId})\n`);

  // 1) Account status (drives login()).
  const acc = await req(`/accounts/${cfg.accountId}`);
  console.log(`GET /accounts/{id} -> HTTP ${acc.status}`);
  if (acc.status === 401 || acc.status === 403) return console.error('AUTH FAILED — check the API key.');
  if (acc.json) {
    console.log('  top-level keys:', Object.keys(acc.json).join(', '));
    const status = acc.json.status || acc.json.sources?.[0]?.status;
    console.log('  status value :', JSON.stringify(status));
    console.log('  account type :', acc.json.type || acc.json.provider);
  }

  // 2) Profile resolve (drives provider_id + network_distance used everywhere).
  const handle = process.argv[2];
  if (handle) {
    const u = await req(`/users/${encodeURIComponent(handle)}?account_id=${cfg.accountId}`);
    console.log(`\nGET /users/${handle} -> HTTP ${u.status}`);
    if (u.json) {
      const p = u.json;
      console.log('  profile keys :', Object.keys(p).join(', '));
      console.log('  provider_id  :', HAS(p.provider_id || p.id || p.member_id), `(provider_id=${!!p.provider_id} id=${!!p.id} member_id=${!!p.member_id})`);
      console.log('  distance     :', HAS(p.network_distance || p.distance), `value=${JSON.stringify(p.network_distance || p.distance)}`);
    } else {
      console.log('  body:', u.text.slice(0, 300));
    }
  } else {
    console.log('\n(Tip: pass a public profile handle to also check provider_id/network_distance.)');
  }

  // 3) Endpoint reachability (read-only listings the inbound flow uses).
  for (const [label, path] of [
    ['received invites', `/users/invite/received?account_id=${cfg.accountId}&limit=1`],
    ['sent invites', `/users/invite/sent?account_id=${cfg.accountId}&limit=1`],
  ]) {
    const r = await req(path);
    console.log(`\nGET ${label.padEnd(16)} -> HTTP ${r.status}` + (r.json ? `  keys: ${Object.keys(r.json).join(', ')}` : ''));
  }
  console.log('\nDone. Send this output (it contains field names, not personal data).\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
