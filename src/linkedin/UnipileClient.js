// Real LinkedIn driver via Unipile (https://www.unipile.com) — a hosted API that
// holds the LinkedIn session for you. Paid, but far more stable than driving a
// browser yourself. Implements the SAME LinkedInClient interface, so switching is
// just LINKEDIN_DRIVER=unipile.
//
// IMPORTANT (honest caveats — validate on your server before trusting it):
//  - Unipile's API field names evolve; calls below are written defensively but
//    the exact shapes (provider ids, invitation + chat endpoints, the "sender"
//    flag) MUST be confirmed against your account first.
//  - Requires UNIPILE_DSN (your API base, e.g. https://apiXXX.unipile.com:13XXX),
//    UNIPILE_API_KEY, and UNIPILE_ACCOUNT_ID (the connected LinkedIn account).
//  - You connect/authenticate the LinkedIn account once in Unipile's dashboard;
//    no scripts/login.js or proxy needed on your side.

import { LinkedInClient } from './LinkedInClient.js';

// Extracts the LinkedIn public identifier from a profile URL, e.g.
// https://www.linkedin.com/in/jane-doe/  ->  jane-doe
export function publicIdFromUrl(url) {
  const m = String(url || '').match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

export class UnipileClient extends LinkedInClient {
  constructor(config, logger = console.log) {
    super();
    this.cfg = config.unipile;
    this.log = logger;
    this.blocked = false;
    this._profiles = new Map(); // url -> resolved provider profile (cache per run)
  }

  isBlocked() {
    return this.blocked;
  }

  async _req(method, path, body) {
    const base = this.cfg.dsn.replace(/\/$/, '');
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'X-API-KEY': this.cfg.apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 401/403 means our session/credentials are no good — trip the breaker.
    if (res.status === 401 || res.status === 403) {
      this.blocked = true;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = new Error(`Unipile ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async login() {
    try {
      const acct = await this._req('GET', `/accounts/${this.cfg.accountId}`);
      // Treat anything but an explicitly-bad status as usable.
      const status = String(acct?.status || acct?.sources?.[0]?.status || 'OK').toUpperCase();
      if (/(CREDENTIALS|DISCONNECT|ERROR|STOPPED)/.test(status)) {
        this.blocked = true;
        return { ok: false, error: `Unipile account status: ${status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // Resolve (and cache) a lead's LinkedIn profile -> provider id + network distance.
  async _resolve(lead) {
    if (this._profiles.has(lead.linkedin_url)) return this._profiles.get(lead.linkedin_url);
    const id = publicIdFromUrl(lead.linkedin_url);
    if (!id) return null;
    const profile = await this._req('GET', `/users/${encodeURIComponent(id)}?account_id=${this.cfg.accountId}`);
    this._profiles.set(lead.linkedin_url, profile);
    return profile;
  }

  _providerId(profile) {
    return profile?.provider_id || profile?.id || profile?.member_id || null;
  }

  _isFirstDegree(profile) {
    const d = String(profile?.network_distance || profile?.distance || '').toUpperCase();
    return d === 'DISTANCE_1' || d === 'FIRST_DEGREE' || d === '1';
  }

  async sendConnectionRequest(lead, note) {
    try {
      const profile = await this._resolve(lead);
      const providerId = this._providerId(profile);
      if (!providerId) return { ok: false, error: 'could not resolve provider id' };
      if (this._isFirstDegree(profile)) return { ok: false, reason: 'already_connected' };
      await this._req('POST', '/users/invite', {
        account_id: this.cfg.accountId,
        provider_id: providerId,
        message: note || undefined,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async isConnected(lead) {
    try {
      // Force a fresh resolve (distance may have changed since the cached invite).
      this._profiles.delete(lead.linkedin_url);
      const profile = await this._resolve(lead);
      return this._isFirstDegree(profile);
    } catch (err) {
      this.log(`[unipile] isConnected error: ${err.message}`);
      return false;
    }
  }

  async sendMessage(lead, text) {
    try {
      const profile = await this._resolve(lead);
      const providerId = this._providerId(profile);
      if (!providerId) return { ok: false, error: 'could not resolve provider id' };
      await this._req('POST', '/chats', {
        account_id: this.cfg.accountId,
        attendees_ids: [providerId],
        text,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async hasReply(lead) {
    try {
      const profile = await this._resolve(lead);
      const providerId = this._providerId(profile);
      if (!providerId) return false;
      const chats = await this._req(
        'GET',
        `/chats?account_id=${this.cfg.accountId}&attendee_id=${encodeURIComponent(providerId)}&limit=1`
      );
      const chat = (chats?.items || chats?.data || [])[0];
      if (!chat?.id) return false;
      const msgs = await this._req('GET', `/chats/${chat.id}/messages?limit=1`);
      const last = (msgs?.items || msgs?.data || [])[0];
      if (!last) return false;
      // is_sender true = WE sent it; a reply means the last message is NOT ours.
      return last.is_sender === false || last.is_sender === 0;
    } catch (err) {
      this.log(`[unipile] hasReply error: ${err.message}`);
      return false;
    }
  }

  async withdrawInvite(lead) {
    try {
      const profile = await this._resolve(lead);
      const providerId = this._providerId(profile);
      const sent = await this._req('GET', `/users/invite/sent?account_id=${this.cfg.accountId}&limit=100`);
      const items = sent?.items || sent?.data || [];
      const match = items.find((i) => (i.provider_id || i.recipient_id) === providerId);
      if (!match?.id) return { ok: true }; // nothing pending to withdraw
      await this._req('DELETE', `/users/invite/sent/${match.id}?account_id=${this.cfg.accountId}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // ---- inbound surface -------------------------------------------------------

  async publishPost(text) {
    try {
      const out = await this._req('POST', '/posts', { account_id: this.cfg.accountId, text });
      return { ok: true, ref: out?.id || out?.post_id || out?.share_id || null };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async getPostComments(post) {
    if (!post?.external_ref) return [];
    try {
      const out = await this._req(
        'GET',
        `/posts/${encodeURIComponent(post.external_ref)}/comments?account_id=${this.cfg.accountId}&limit=100`
      );
      const items = out?.items || out?.data || [];
      return items.map((c) => {
        const author = c.author || c.from || {};
        const handle = author.public_identifier || author.public_id || null;
        return {
          name: author.name || [author.first_name, author.last_name].filter(Boolean).join(' ') || null,
          profileUrl: handle ? `https://www.linkedin.com/in/${handle}` : null,
          profileRef: author.provider_id || author.id || handle || null,
          text: c.text || c.body || '',
          commentId: c.id || null,
        };
      });
    } catch (err) {
      this.log(`[unipile] getPostComments error: ${err.message}`);
      return [];
    }
  }

  async getPendingInvites() {
    try {
      const out = await this._req('GET', `/users/invite/received?account_id=${this.cfg.accountId}&limit=100`);
      const items = out?.items || out?.data || [];
      return items.map((i) => {
        const from = i.from || i.user || {};
        return {
          name: from.name || null,
          profileRef: from.provider_id || from.id || null,
          invitationId: i.id || i.invitation_id || null,
        };
      });
    } catch (err) {
      this.log(`[unipile] getPendingInvites error: ${err.message}`);
      return [];
    }
  }

  async acceptInvite(invite) {
    try {
      if (!invite?.invitationId) return { ok: false, error: 'no invitationId' };
      await this._req(
        'POST',
        `/users/invite/received/${encodeURIComponent(invite.invitationId)}/accept?account_id=${this.cfg.accountId}`
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
