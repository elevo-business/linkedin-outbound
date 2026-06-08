// CRM factory: pick the hand-off target from config. `none` (default) returns a
// no-op client so the machine runs without a CRM.

import { NullCrmClient } from './CrmClient.js';
import { MockCrmClient } from './MockCrmClient.js';

export async function createCrmClient(config, logger = console.log) {
  switch (config.crm.provider) {
    case 'none':
      return new NullCrmClient();
    case 'mock':
      return new MockCrmClient({ logger });
    case 'pipedrive': {
      const { PipedriveClient } = await import('./PipedriveClient.js');
      return new PipedriveClient(config, logger);
    }
    default:
      throw new Error(`Unknown CRM_PROVIDER: ${config.crm.provider}`);
  }
}

// Sync an engagement to the CRM once (idempotent via crm_synced_at). Returns the
// created ref or null. Shared by the capture server and the inbound sequencer.
export async function syncEngagementToCrm(crm, engagements, db, engagement, now = new Date()) {
  if (!crm.enabled) return null;
  const fresh = engagements.byId(engagement.id);
  if (!fresh || fresh.crm_synced_at) return fresh?.crm_ref ?? null;
  const res = await crm.createLead(fresh);
  if (res.ok) {
    engagements.markCrmSynced(fresh.id, res.id, now.toISOString());
    db.logEvent(fresh.id, 'crm_created', res.id ? String(res.id) : null, now.toISOString());
    return res.id ?? null;
  }
  if (!res.skipped) db.logEvent(fresh.id, 'crm_create_failed', res.error, now.toISOString());
  return null;
}
