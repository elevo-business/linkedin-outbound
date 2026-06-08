#!/usr/bin/env node
// Start the gated capture web server (landing pages + email capture + tracking).
//   node scripts/capture-server.js
// Put this behind a public URL and set CAPTURE_BASE_URL to match.

import { loadConfig } from '../src/config.js';
import { createCaptureServer } from '../src/server/captureServer.js';

const config = loadConfig();
const server = createCaptureServer(config);
server.listen(config.server.capturePort, () => {
  console.log(`Capture server on :${config.server.capturePort} (base ${config.inbound.captureBaseUrl})`);
});
