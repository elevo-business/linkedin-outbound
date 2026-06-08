// Driver factory: pick the access layer from config.
// Swap `LINKEDIN_DRIVER` to migrate (mock -> playwright -> unipile) without
// touching the sequencer.

import { MockClient } from './MockClient.js';

export async function createClient(config, logger = console.log) {
  switch (config.driver) {
    case 'mock':
      return new MockClient({ logger });
    case 'playwright': {
      const { PlaywrightClient } = await import('./PlaywrightClient.js');
      return new PlaywrightClient(config, logger);
    }
    // Future: case 'unipile': return new UnipileClient(config, logger);
    default:
      throw new Error(`Unknown LINKEDIN_DRIVER: ${config.driver}`);
  }
}
