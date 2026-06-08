// Pipedrive CRM hand-off via API token. Creates a person (+ email) and a lead so
// the people you take over land in your pipeline automatically.
//
// IMPORTANT (honest caveat — validate against your Pipedrive before trusting):
//  - Auth is the API token (Settings -> Personal preferences -> API), passed as
//    the `api_token` query param.
//  - Endpoints/fields are written defensively but confirm them for your account.
//  - Requires PIPEDRIVE_API_TOKEN. Default host is api.pipedrive.com; set
//    PIPEDRIVE_BASE_URL to your company domain if needed.

import { CrmClient } from './CrmClient.js';

export class PipedriveClient extends CrmClient {
  constructor(config, logger = console.log) {
    super();
    this.cfg = config.crm.pipedrive;
    this.log = logger;
  }

  get enabled() {
    return Boolean(this.cfg.apiToken);
  }

  async _req(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}${path}${sep}api_token=${encodeURIComponent(this.cfg.apiToken)}`;
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || json?.success === false) {
      throw new Error(`Pipedrive ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return json?.data ?? json;
  }

  async createLead(engagement) {
    try {
      const name = engagement.name || this._nameFromUrl(engagement.linkedin_url) || 'LinkedIn lead';
      const personBody = { name };
      if (engagement.email) personBody.email = [{ value: engagement.email, primary: true, label: 'work' }];
      const person = await this._req('POST', '/persons', personBody);
      const personId = person?.id;

      const title = `${name} — LinkedIn inbound`;
      const leadBody = { title, person_id: personId };
      if (this.cfg.ownerId) leadBody.owner_id = Number(this.cfg.ownerId);
      const lead = await this._req('POST', '/leads', leadBody);

      // Attach the LinkedIn profile + comment as a note (best-effort, non-fatal).
      if (lead?.id && engagement.linkedin_url) {
        try {
          await this._req('POST', '/notes', {
            lead_id: lead.id,
            content: `LinkedIn: ${engagement.linkedin_url}\nComment: ${engagement.comment_text || ''}`,
          });
        } catch (err) {
          this.log(`[crm:pipedrive] note failed (non-fatal): ${err.message}`);
        }
      }
      return { ok: true, id: lead?.id ?? personId ?? null };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  _nameFromUrl(url) {
    const m = String(url || '').match(/\/in\/([^/?#]+)/);
    return m ? m[1].replace(/-/g, ' ') : null;
  }
}
