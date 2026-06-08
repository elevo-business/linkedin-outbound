#!/usr/bin/env node
// Go-live check: tells you exactly what's missing for the first inbound post to
// go out with a complete setup.
//   node scripts/preflight.js

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db/db.js';
import { preflightChecks, summarize } from '../src/preflight.js';

const pexec = promisify(execFile);
const ICON = { ok: '✅', warn: '🟡', block: '❌' };

async function claudeAvailable(bin) {
  try {
    await pexec(bin, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function pingCapture(base) {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const config = loadConfig();
  const db = new Db(config.dbPath);
  const checks = await preflightChecks(config, db, {
    claudeAvailable: config.personalizer.mode === 'claude-cli' ? await claudeAvailable(config.personalizer.claudeBin) : undefined,
    pingCapture,
  });

  console.log('\n=== Go-live preflight ===\n');
  for (const c of checks) console.log(`  ${ICON[c.level]} ${c.name.padEnd(26)} ${c.detail}`);

  const { blocks, warns, ready } = summarize(checks);
  console.log('');
  if (ready) console.log(`🚀 READY to publish the first post (${warns} warning(s)). Run: npm run capture-server  &  npm run inbound-tick`);
  else console.log(`⛔ NOT READY — ${blocks} blocker(s), ${warns} warning(s). Fix the ❌ items above.`);
  console.log('');
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
