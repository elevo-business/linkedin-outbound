// Abstract CRM hand-off layer. A captured / taken-over engagement is pushed to
// the CRM (a person + a lead). Swappable like the access and email layers.

export class CrmClient {
  get enabled() {
    return false;
  }

  /** Create/sync a lead from an engagement. Returns { ok, id?, error? }. */
  async createLead(_engagement) {
    throw new Error('not implemented');
  }

  async close() {}
}

// Default when CRM_PROVIDER=none.
export class NullCrmClient extends CrmClient {
  get enabled() {
    return false;
  }
  async createLead() {
    return { ok: false, skipped: true };
  }
}
