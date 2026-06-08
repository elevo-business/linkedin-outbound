#!/usr/bin/env node
// Start the password-protected admin dashboard (monitor + control everything).
//   ADMIN_PASSWORD=... node scripts/admin-server.js
// Put it behind HTTPS (e.g. a Coolify/Caddy/nginx reverse proxy).

import { loadConfig } from '../src/config.js';
import { createAdminServer } from '../src/server/adminServer.js';

const config = loadConfig();
if (!config.server.adminPassword) {
  console.warn('⚠️  ADMIN_PASSWORD is not set — login is disabled until you set it in .env');
}
const server = createAdminServer(config);
server.listen(config.server.adminPort, () => {
  console.log(`Admin dashboard on :${config.server.adminPort}`);
});
