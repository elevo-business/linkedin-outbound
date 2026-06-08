// Real email channel via Instantly (https://instantly.ai) API v2.
//
// IMPORTANT (honest caveats — like PlaywrightClient, validate on your server):
//  - Instantly's API shapes change; the request/response handling below is
//    written defensively but the exact field names (reply counters, pause
//    endpoint) MUST be confirmed against your account before trusting it.
//  - Auth is a Bearer API key from your Instantly workspace settings.
//  - Requires INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID in .env.
//
// All methods return plain results and never throw for ordinary failures.

import { EmailClient } from './EmailClient.js';

const firstName = (name) => (name ? name.trim().split(/\s+/)[0] : '');
const lastName = (name) => {
  const parts = (name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
};

export class InstantlyClient extends EmailClient {
  constructor(config, logger = console.log) {
    super();
    this.cfg = config.email.instantly;
    this.log = logger;
  }

  get enabled() {
    return Boolean(this.cfg.apiKey && this.cfg.campaignId);
  }

  async _req(method, path, body) {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }
    if (!res.ok) {
      const err = new Error(`Instantly ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async enroll(lead) {
    if (!lead.email) return { ok: false, error: 'lead has no email' };
    try {
      await this._req('POST', '/leads', {
        campaign: this.cfg.campaignId,
        email: lead.email,
        first_name: firstName(lead.name),
        last_name: lastName(lead.name),
        company_name: lead.company || '',
        personalization: lead.headline || '',
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // Look up the Instantly lead id for an email within our campaign.
  async _findLead(email) {
    const out = await this._req('POST', '/leads/list', {
      campaign: this.cfg.campaignId,
      search: email,
      limit: 1,
    });
    const items = out?.items || out?.data || (Array.isArray(out) ? out : []);
    return items[0] || null;
  }

  async hasReply(lead) {
    if (!lead.email) return false;
    try {
      const item = await this._findLead(lead.email);
      if (!item) return false;
      // Defensive: different payloads expose replies differently.
      const replies = item.email_reply_count ?? item.reply_count ?? 0;
      if (Number(replies) > 0) return true;
      return /repl/i.test(String(item.status || item.lead_status || ''));
    } catch (err) {
      this.log(`[email:instantly] hasReply error: ${err.message}`);
      return false;
    }
  }

  async pause(lead) {
    if (!lead.email) return { ok: true };
    try {
      const item = await this._findLead(lead.email);
      if (!item?.id) return { ok: false, error: 'lead not found to pause' };
      // Pause far into the future = effectively stop the sequence.
      await this._req('PATCH', `/leads/${item.id}`, { pause_until: '2999-01-01' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
