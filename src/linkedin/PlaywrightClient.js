// Real LinkedIn driver via Playwright. Loaded lazily so the rest of the project
// installs and tests without the (heavy) playwright dependency.
//
// IMPORTANT (honest caveats):
//  - LinkedIn changes its DOM frequently. The selectors below are written
//    defensively (role/text based) but WILL occasionally need maintenance.
//  - First run needs a manual login to create the session file:
//        node scripts/login.js
//    That opens a real browser; log in, solve any checkpoint, then it saves
//    the session to LINKEDIN_SESSION_PATH. Automation reuses that session.
//  - On a datacenter VPS you MUST set a residential PROXY matching your usual
//    login location, or LinkedIn will flag the session quickly.

import fs from 'node:fs';
import { LinkedInClient } from './LinkedInClient.js';

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanPause = () => sleep(rand(700, 2500));

export class PlaywrightClient extends LinkedInClient {
  constructor(config, logger = console.log) {
    super();
    this.config = config;
    this.log = logger;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.blocked = false; // tripped when LinkedIn shows a checkpoint / auth wall
  }

  isBlocked() {
    return this.blocked;
  }

  // True if the current page is a login / checkpoint / auth-wall URL — i.e. our
  // session got challenged. Any nav that lands here means we must stop sending.
  _onCheckpoint() {
    return /\/(login|checkpoint|authwall|uas\/login)/.test(this.page?.url() || '');
  }

  async _launch() {
    const { chromium } = await import('playwright');
    const pw = this.config.playwright;

    const launchOpts = { headless: pw.headless };
    if (pw.proxyServer) {
      launchOpts.proxy = {
        server: pw.proxyServer,
        username: pw.proxyUsername || undefined,
        password: pw.proxyPassword || undefined,
      };
    }
    this.browser = await chromium.launch(launchOpts);

    const ctxOpts = {
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (fs.existsSync(pw.sessionPath)) {
      ctxOpts.storageState = pw.sessionPath;
    }
    this.context = await this.browser.newContext(ctxOpts);
    this.page = await this.context.newPage();
  }

  async login() {
    if (!this.page) await this._launch();
    await this.page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await humanPause();
    // If we got redirected to a login/checkpoint page, the session is invalid.
    if (this._onCheckpoint()) {
      this.blocked = true;
      return {
        ok: false,
        error: 'Not logged in / checkpoint. Run `node scripts/login.js` to create a session.',
      };
    }
    return { ok: true };
  }

  async _gotoProfile(lead) {
    await this.page.goto(lead.linkedin_url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await humanPause();
    // A profile nav that lands on a checkpoint means the session is challenged;
    // trip the breaker and bail out hard so the sequencer stops sending.
    if (this._onCheckpoint()) {
      this.blocked = true;
      throw new Error('CHECKPOINT: LinkedIn challenged the session');
    }
  }

  async _typeHuman(locator, text) {
    await locator.click();
    for (const ch of text) {
      await locator.type(ch, { delay: rand(30, 110) });
    }
  }

  async sendConnectionRequest(lead, note) {
    try {
      await this._gotoProfile(lead);

      // Primary: a top-level "Connect" button. Fallback: under the "More" menu.
      let connectBtn = this.page
        .getByRole('button', { name: /^Connect$/i })
        .first();
      if (!(await connectBtn.count())) {
        const moreBtn = this.page.getByRole('button', { name: /^More/i }).first();
        if (await moreBtn.count()) {
          await moreBtn.click();
          await humanPause();
          connectBtn = this.page
            .getByRole('menuitem', { name: /Connect/i })
            .first();
        }
      }
      if (!(await connectBtn.count())) {
        return { ok: false, error: 'Connect button not found (already connected/pending?)' };
      }
      await connectBtn.click();
      await humanPause();

      if (note) {
        const addNote = this.page.getByRole('button', { name: /Add a note/i }).first();
        if (await addNote.count()) {
          await addNote.click();
          await humanPause();
          const textarea = this.page.locator('textarea#custom-message, textarea[name="message"]').first();
          if (await textarea.count()) {
            await this._typeHuman(textarea, note.slice(0, 300));
            await humanPause();
          }
        }
      }

      const sendBtn = this.page
        .getByRole('button', { name: /^(Send|Send invitation|Send now)$/i })
        .first();
      if (!(await sendBtn.count())) {
        return { ok: false, error: 'Send button not found' };
      }
      await sendBtn.click();
      await humanPause();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async isConnected(lead) {
    try {
      await this._gotoProfile(lead);
      // "Pending" button visible => invite not yet accepted.
      const pending = this.page.getByRole('button', { name: /Pending/i }).first();
      if (await pending.count()) return false;
      // A direct "Message" button at profile level is a strong signal of 1st-degree.
      const message = this.page.getByRole('button', { name: /^Message$/i }).first();
      return (await message.count()) > 0;
    } catch (err) {
      this.log(`[playwright] isConnected error: ${err.message}`);
      return false;
    }
  }

  async _openConversation(lead) {
    await this._gotoProfile(lead);
    const messageBtn = this.page.getByRole('button', { name: /^Message$/i }).first();
    if (!(await messageBtn.count())) return false;
    await messageBtn.click();
    await humanPause();
    return true;
  }

  async sendMessage(lead, text) {
    try {
      if (!(await this._openConversation(lead))) {
        return { ok: false, error: 'Could not open conversation' };
      }
      const box = this.page.locator('div.msg-form__contenteditable[contenteditable="true"]').first();
      if (!(await box.count())) {
        return { ok: false, error: 'Message box not found' };
      }
      await this._typeHuman(box, text);
      await humanPause();
      const send = this.page.getByRole('button', { name: /^Send$/i }).last();
      await send.click();
      await humanPause();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async hasReply(lead) {
    try {
      if (!(await this._openConversation(lead))) return false;
      // Heuristic: in an open thread, find message events and check whether the
      // last one is from the lead (i.e. not "You").
      const events = this.page.locator('li.msg-s-message-list__event');
      const count = await events.count();
      if (count === 0) return false;
      const last = events.nth(count - 1);
      const senderName = (await last.locator('.msg-s-message-group__name').first().textContent().catch(() => '')) || '';
      const name = senderName.trim();
      // Empty name is ambiguous (own messages often omit the name block); don't
      // treat that as a reply — better to miss one than to wrongly stop sequencing.
      if (!name) return false;
      return !/^you$/i.test(name);
    } catch (err) {
      this.log(`[playwright] hasReply error: ${err.message}`);
      return false;
    }
  }

  async withdrawInvite(lead) {
    try {
      await this._gotoProfile(lead);
      const pending = this.page.getByRole('button', { name: /Pending/i }).first();
      // No pending button => already accepted or already withdrawn; treat as done.
      if (!(await pending.count())) return { ok: true };
      await pending.click();
      await humanPause();
      // LinkedIn shows a confirm dialog with a "Withdraw" button.
      const withdraw = this.page.getByRole('button', { name: /Withdraw/i }).first();
      if (!(await withdraw.count())) return { ok: false, error: 'Withdraw button not found' };
      await withdraw.click();
      await humanPause();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async close() {
    try {
      if (this.context) await this.context.storageState({ path: this.config.playwright.sessionPath });
    } catch { /* ignore */ }
    if (this.browser) await this.browser.close();
  }
}
