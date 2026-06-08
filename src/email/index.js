// Email-channel factory: pick the second-channel driver from config.
// `none` (default) returns a no-op client so the sequencer runs LinkedIn-only.

import { NullEmailClient } from './EmailClient.js';
import { MockEmailClient } from './MockEmailClient.js';

export async function createEmailClient(config, logger = console.log) {
  switch (config.email.channel) {
    case 'none':
      return new NullEmailClient();
    case 'mock':
      return new MockEmailClient({ logger });
    case 'instantly': {
      const { InstantlyClient } = await import('./InstantlyClient.js');
      return new InstantlyClient(config, logger);
    }
    default:
      throw new Error(`Unknown EMAIL_CHANNEL: ${config.email.channel}`);
  }
}
