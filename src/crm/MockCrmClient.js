// In-memory CRM: records calls, performs nothing. For tests and EMAIL/CRM=mock.

import { CrmClient } from './CrmClient.js';

export class MockCrmClient extends CrmClient {
  constructor(opts = {}) {
    super();
    this.failCreate = opts.failCreate ?? false;
    this.logger = opts.logger ?? (() => {});
    this.actions = [];
    this._seq = 0;
  }

  get enabled() {
    return true;
  }

  async createLead(engagement) {
    this.actions.push({ type: 'createLead', id: engagement.id, name: engagement.name, email: engagement.email });
    this.logger(`[crm:mock] createLead -> ${engagement.name || engagement.linkedin_url}`);
    if (this.failCreate) return { ok: false, error: 'mock: failCreate' };
    return { ok: true, id: `mock-${++this._seq}` };
  }
}
