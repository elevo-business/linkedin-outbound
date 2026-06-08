// Minimal gated capture server (no dependencies — built-in http).
//   GET  /m/:slug?e=<id>   landing page; logs a click attributed to engagement <id>
//   POST /m/:slug          { email, e } captures the email, delivers the magnet,
//                          marks the engagement delivered, and syncs it to the CRM
//   GET  /health           liveness
//
// Delivery + tracking flow:
//   the magnet DM links here -> click is tracked -> (gated) email captured ->
//   resource shown -> CRM lead created.

import http from 'node:http';
import { Db } from '../db/db.js';
import { Magnets } from '../db/magnets.js';
import { Engagements, ENGAGEMENT_STATUS as ES } from '../db/engagements.js';
import { createCrmClient, syncEngagementToCrm } from '../crm/index.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function page(title, inner) {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:6vh auto;padding:0 20px;color:#1a1a1a}` +
    `pre{white-space:pre-wrap;background:#f6f6f6;padding:16px;border-radius:8px}` +
    `input,button{font:inherit;padding:10px 14px;border-radius:8px;border:1px solid #ccc}` +
    `button{background:#0a66c2;color:#fff;border:0;cursor:pointer}</style></head><body>${inner}</body></html>`
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
  });
}

export function createCaptureServer(config, deps = {}) {
  const db = deps.db || new Db(config.dbPath);
  const magnets = deps.magnets || new Magnets(db);
  const engagements = deps.engagements || new Engagements(db);
  const crmPromise = deps.crm ? Promise.resolve(deps.crm) : createCrmClient(config, () => {});

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const send = (code, type, body) => {
        res.writeHead(code, { 'content-type': type });
        res.end(body);
      };

      if (url.pathname === '/health') return send(200, 'text/plain', 'ok');

      const m = url.pathname.match(/^\/m\/([^/]+)$/);
      if (!m) return send(404, 'text/plain', 'Not found');
      const slug = decodeURIComponent(m[1]);
      const magnet = magnets.bySlug(slug);
      if (!magnet) return send(404, 'text/html', page('Not found', '<h1>Not found</h1>'));

      if (req.method === 'GET') {
        const eid = Number(url.searchParams.get('e')) || null;
        if (eid) db.logEvent(eid, 'magnet_click', slug);
        const gated = magnet.delivery === 'gated';
        const inner = gated
          ? `<h1>${esc(magnet.name)}</h1><p>${esc(magnet.description || '')}</p>` +
            `<form method="post"><input type="hidden" name="e" value="${eid || ''}">` +
            `<input type="email" name="email" placeholder="you@company.com" required> ` +
            `<button type="submit">Send it to me</button></form>`
          : `<h1>${esc(magnet.name)}</h1><p>${esc(magnet.description || '')}</p><pre>${esc(magnet.body || '')}</pre>`;
        return send(200, 'text/html', page(magnet.name, inner));
      }

      if (req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req));
        const email = (params.get('email') || '').trim();
        const eid = Number(params.get('e')) || null;
        if (!email) return send(400, 'text/html', page('Missing email', '<p>Please enter an email.</p>'));

        if (eid) {
          const e = engagements.byId(eid);
          if (e) {
            engagements.setEmail(eid, email);
            engagements.setStatus(eid, ES.DELIVERED, { stampColumn: 'delivered_at' });
            db.logEvent(eid, 'email_captured', slug);
            if (['capture', 'both'].includes(config.crm.createOn)) {
              const crm = await crmPromise;
              await syncEngagementToCrm(crm, engagements, db, engagements.byId(eid));
            }
          }
        }
        const inner = `<h1>You're in 🎉</h1><p>Here's <b>${esc(magnet.name)}</b>:</p><pre>${esc(magnet.body || '')}</pre>`;
        return send(200, 'text/html', page('Thanks', inner));
      }

      return send(405, 'text/plain', 'Method not allowed');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Server error');
      (deps.logger || console.error)(`[capture] ${err.message}`);
    }
  });
}
