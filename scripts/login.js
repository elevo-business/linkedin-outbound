#!/usr/bin/env node
// One-time manual login to create the Playwright session file.
// Opens a REAL browser; log in (solve any checkpoint), then press Enter here.
// The session is saved to LINKEDIN_SESSION_PATH and reused by the automation.
//
//   node scripts/login.js
//
// Requires: npm install playwright && npx playwright install chromium

import readline from 'node:readline';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

async function main() {
  const { chromium } = await import('playwright');
  const pw = config.playwright;

  const launchOpts = { headless: false };
  if (pw.proxyServer) {
    launchOpts.proxy = {
      server: pw.proxyServer,
      username: pw.proxyUsername || undefined,
      password: pw.proxyPassword || undefined,
    };
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/login');

  console.log('\nA browser window opened. Log in to LinkedIn, finish any checkpoint,');
  console.log('land on your feed, then come back here and press Enter to save the session.');

  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter once logged in… ', () => { rl.close(); resolve(); });
  });

  await context.storageState({ path: pw.sessionPath });
  console.log(`Session saved to ${pw.sessionPath}`);
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
