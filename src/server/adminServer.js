// Password-protected admin dashboard (built-in http, no deps). Monitor and steer
// the whole machine: campaigns, magnets, posts, engagements, learning, preflight,
// circuit breaker — and trigger actions (create campaign, generate content,
// publish now, run a tick).
//
// Auth: a single ADMIN_PASSWORD + an in-memory session cookie (re-login after a
// restart). Forms carry a per-session CSRF token. Put this behind HTTPS.

import http from 'node:http';
import crypto from 'node:crypto';
import { Db } from '../db/db.js';
import { Campaigns } from '../db/campaigns.js';
import { Magnets } from '../db/magnets.js';
import { Posts, POST_STATUS } from '../db/posts.js';
import { Engagements } from '../db/engagements.js';
import { RateLimiter } from '../core/rateLimiter.js';
import { breakerActive } from '../core/breaker.js';
import { ContentGenerator, POST_HOOKS } from '../inbound/contentGenerator.js';
import { hookStats, pickHook } from '../inbound/learning.js';
import { preflightChecks, summarize } from '../preflight.js';

const DAY = 24 * 3600 * 1000;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const readBody = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => res(d)); });
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const timingEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function layout(title, body, csrf, flash) {
  const nav = ['/', '/campaigns', '/posts', '/engagements', '/preflight']
    .map((p) => `<a href="${p}">${p === '/' ? 'Overview' : p.slice(1)}</a>`)
    .join(' · ');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)} — Admin</title><style>` +
    `body{font:15px/1.5 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1a1a1a}` +
    `h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #eee;padding-bottom:4px}` +
    `nav{margin-bottom:18px;font-size:14px}nav a{color:#0a66c2;text-decoration:none;margin-right:4px}` +
    `table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #e5e5e5;padding:5px 8px;text-align:left}` +
    `form.inline{display:inline}input,select,textarea,button{font:inherit;padding:6px 9px;border-radius:6px;border:1px solid #ccc;margin:2px 0}` +
    `button{background:#0a66c2;color:#fff;border:0;cursor:pointer}.muted{color:#888}.flash{background:#eef7ee;border:1px solid #bcd;padding:8px 12px;border-radius:6px;margin:10px 0}` +
    `.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{border:1px solid #eee;border-radius:8px;padding:10px}.big{font-size:22px;font-weight:600}` +
    `.block{color:#b00}.warn{color:#b80}.ok{color:#080}</style></head><body>` +
    `<h1>🦾 LinkedIn Lead Machine — Admin</h1><nav>${nav} · <form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button>logout</button></form></nav>` +
    (flash ? `<div class="flash">${esc(flash)}</div>` : '') +
    body +
    `</body></html>`
  );
}

function loginPage(error, hasPassword) {
  return (
    `<!doctype html><meta charset="utf-8"><title>Login</title>` +
    `<body style="font:15px system-ui;max-width:340px;margin:12vh auto"><h1>🦾 Admin login</h1>` +
    (hasPassword ? '' : `<p style="color:#b00">ADMIN_PASSWORD is not set — set it in .env to enable login.</p>`) +
    (error ? `<p style="color:#b00">${esc(error)}</p>` : '') +
    `<form method="post" action="/login"><input type="password" name="password" placeholder="password" autofocus style="width:100%;padding:9px;margin:6px 0">` +
    `<button style="width:100%;padding:9px;background:#0a66c2;color:#fff;border:0;border-radius:6px">Log in</button></form></body>`
  );
}

export function createAdminServer(config, deps = {}) {
  const db = deps.db || new Db(config.dbPath);
  const campaigns = new Campaigns(db);
  const magnets = new Magnets(db);
  const posts = new Posts(db);
  const engagements = new Engagements(db);
  const rate = new RateLimiter(db, config);
  const gen = deps.contentGenerator || new ContentGenerator(config, () => {});
  // Injectable so tests don't hit the network; default builds the real inbound tick.
  const runTick = deps.runTick || (async () => {
    const { buildInbound } = await import('../inboundRunner.js');
    const built = await buildInbound(config, () => {});
    try {
      const login = await built.client.login();
      if (!login.ok) return { skipped: `login failed: ${login.error}` };
      return await built.sequencer.tick();
    } finally {
      await built.client.close();
    }
  });

  const sessions = new Map(); // sid -> { csrf }
  const newSession = () => {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { csrf: crypto.randomBytes(16).toString('hex') });
    return sid;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (code, html, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
    const redirect = (to, cookie) => { const h = { location: to }; if (cookie) h['set-cookie'] = cookie; res.writeHead(302, h); res.end(); };
    try {
      const cookies = parseCookies(req);
      const session = sessions.get(cookies.sid);
      const body = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : null;

      // --- auth ---
      if (url.pathname === '/login') {
        if (req.method === 'GET') return send(200, loginPage(null, Boolean(config.server.adminPassword)));
        if (!config.server.adminPassword) return send(200, loginPage('No password configured.', false));
        if (timingEq(body.get('password') || '', config.server.adminPassword)) {
          const sid = newSession();
          return redirect('/', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
        }
        return send(401, loginPage('Wrong password.', true));
      }
      if (!session) return redirect('/login');
      if (req.method === 'POST') {
        if ((body.get('_csrf') || '') !== session.csrf) return send(403, 'bad csrf token');
        if (url.pathname === '/logout') { sessions.delete(cookies.sid); return redirect('/login', 'sid=; Max-Age=0; Path=/'); }
      }
      const csrf = session.csrf;
      const flash = url.searchParams.get('m');

      // --- POST actions ---
      if (req.method === 'POST') {
        if (url.pathname === '/campaigns/create') {
          const id = campaigns.create({
            name: body.get('name') || 'Untitled', icp: body.get('icp'), topics: body.get('topics'),
            trigger_word: body.get('trigger') || config.inbound.triggerWord, delivery: body.get('delivery') || 'dm',
            value_prop: body.get('value_prop'), sender_name: body.get('sender_name'), sender_role: body.get('sender_role'),
          });
          return redirect(`/campaigns?m=${encodeURIComponent('Created campaign #' + id)}`);
        }
        let m;
        if ((m = url.pathname.match(/^\/campaigns\/(\d+)\/(pause|activate)$/))) {
          campaigns.setStatus(Number(m[1]), m[2] === 'pause' ? 'paused' : 'active');
          return redirect('/campaigns?m=updated');
        }
        if (url.pathname === '/magnets/create') {
          const campaign = body.get('campaign_id') ? campaigns.byId(Number(body.get('campaign_id'))) : null;
          const magnet = await gen.magnet(body.get('topic') || '', campaign);
          const id = magnets.create({ ...magnet, campaign_id: campaign?.id ?? null, delivery: campaign?.delivery ?? config.inbound.deliveryMode });
          return redirect(`/posts?m=${encodeURIComponent('Created magnet #' + id + ' (' + magnet.name + ')')}`);
        }
        if (url.pathname === '/posts/create') {
          const magnet = magnets.byId(Number(body.get('magnet_id')));
          if (magnet) {
            const campaign = magnet.campaign_id ? campaigns.byId(magnet.campaign_id) : null;
            const count = Math.min(10, Math.max(1, Number(body.get('count') || 1)));
            const mode = body.get('mode'); // draft | schedule | now
            for (let i = 0; i < count; i++) {
              const hook = body.get('learn') ? pickHook(db, POST_HOOKS) : POST_HOOKS[i % POST_HOOKS.length];
              const p = await gen.post(magnet, hook, campaign);
              const scheduled_at = mode === 'now' ? new Date().toISOString() : mode === 'schedule' ? new Date(Date.now() + (i + 1) * DAY).toISOString() : null;
              posts.create({ campaign_id: campaign?.id ?? null, magnet_id: magnet.id, status: mode === 'draft' || !mode ? POST_STATUS.DRAFT : POST_STATUS.SCHEDULED, body: p.body, hook: p.hook, trigger_word: p.trigger_word, scheduled_at });
            }
            return redirect(`/posts?m=${encodeURIComponent('Generated ' + count + ' post(s)')}`);
          }
          return redirect('/posts?m=magnet+not+found');
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/publish-now$/))) {
          posts.schedule(Number(m[1]), new Date().toISOString());
          return redirect('/posts?m=scheduled+now');
        }
        if (url.pathname === '/tick') {
          const s = await runTick();
          return redirect(`/?m=${encodeURIComponent('Tick: ' + JSON.stringify(s).slice(0, 160))}`);
        }
        return send(404, 'unknown action');
      }

      // --- GET pages ---
      if (url.pathname === '/') return send(200, layout('Overview', overview(csrf), csrf, flash));
      if (url.pathname === '/campaigns') return send(200, layout('Campaigns', campaignsPage(csrf), csrf, flash));
      if (url.pathname === '/posts') return send(200, layout('Posts', postsPage(csrf), csrf, flash));
      if (url.pathname === '/engagements') return send(200, layout('Engagements', engagementsPage(), csrf, flash));
      if (url.pathname === '/preflight') return send(200, layout('Preflight', await preflightPage(), csrf, flash));
      return send(404, 'Not found');
    } catch (err) {
      (deps.logger || console.error)(`[admin] ${err.stack || err.message}`);
      res.writeHead(500); res.end('Server error');
    }
  });

  // ---- page renderers ----
  function overview(csrf) {
    const now = new Date();
    const ec = engagements.counts();
    const pc = posts.counts();
    const card = (label, val, cls = '') => `<div class="card"><div class="muted">${label}</div><div class="big ${cls}">${val}</div></div>`;
    const breaker = breakerActive(db, config, now);
    return (
      `<div class="grid">` +
      card('Campaigns', campaigns.all().length) +
      card('Posts published', pc.published || 0) +
      card('Engagements', Object.values(ec).reduce((a, b) => a + b, 0)) +
      card('Replied', ec.replied || 0, 'ok') +
      card('Invites today', db.countEventsSince('invite_sent', DAY, now)) +
      card('Inbound DMs today', db.countEventsSince('message_sent', DAY, now)) +
      card('Captures (30d)', db.countEventsSince('email_captured', 30 * DAY, now)) +
      card('CRM created (30d)', db.countEventsSince('crm_created', 30 * DAY, now)) +
      `</div>` +
      `<p style="margin-top:14px">Circuit breaker: <b class="${breaker ? 'block' : 'ok'}">${breaker ? 'ACTIVE — paused' : 'ok'}</b> · driver <b>${esc(config.driver)}</b> · CRM <b>${esc(config.crm.provider)}</b></p>` +
      `<form method="post" action="/tick"><input type="hidden" name="_csrf" value="${csrf}"><button>▶ Run inbound tick now</button> <span class="muted">(publish due posts, scan, deliver — respects all safety gates)</span></form>` +
      hookTable()
    );
  }

  function hookTable() {
    const stats = hookStats(db);
    const rows = Object.keys(stats).sort((a, b) => stats[b].rate - stats[a].rate)
      .map((h) => `<tr><td>${esc(h)}</td><td>${stats[h].engagements}/${stats[h].posts}</td><td>${stats[h].rate.toFixed(2)}</td></tr>`).join('');
    if (!rows) return '';
    return `<h2>Hook performance (learning)</h2><table><tr><th>hook</th><th>eng/posts</th><th>rate</th></tr>${rows}</table>`;
  }

  function campaignsPage(csrf) {
    const rows = campaigns.all().map((c) => (
      `<tr><td>#${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.icp || '—')}</td><td>${esc(c.trigger_word || '—')}</td><td>${esc(c.delivery)}</td>` +
      `<td>${c.status}</td><td><form class="inline" method="post" action="/campaigns/${c.id}/${c.status === 'active' ? 'pause' : 'activate'}"><input type="hidden" name="_csrf" value="${csrf}"><button>${c.status === 'active' ? 'pause' : 'activate'}</button></form></td></tr>`
    )).join('');
    return (
      `<h2>Campaigns</h2><table><tr><th>id</th><th>name</th><th>icp</th><th>trigger</th><th>delivery</th><th>status</th><th></th></tr>${rows || '<tr><td colspan=7 class=muted>none yet</td></tr>'}</table>` +
      `<h2>New campaign</h2><form method="post" action="/campaigns/create"><input type="hidden" name="_csrf" value="${csrf}">` +
      `<input name="name" placeholder="name" required> <input name="icp" placeholder="ICP / audience" size="32"><br>` +
      `<input name="topics" placeholder="topics (comma)" size="32"> <input name="trigger" placeholder="trigger word"> ` +
      `<select name="delivery"><option value="dm">dm</option><option value="gated">gated</option></select><br>` +
      `<input name="value_prop" placeholder="what you do / value prop" size="40"><br>` +
      `<input name="sender_name" placeholder="sender name"> <input name="sender_role" placeholder="sender role"><br><button>Create campaign</button></form>`
    );
  }

  function postsPage(csrf) {
    const list = [...posts.byStatus('scheduled'), ...posts.byStatus('published'), ...posts.byStatus('draft')];
    const rows = list.map((p) => (
      `<tr><td>#${p.id}</td><td>${p.status}</td><td>${esc(p.hook || '')}</td><td>${esc(p.trigger_word || '')}</td><td>${esc((p.body || '').slice(0, 60))}…</td>` +
      `<td>${p.status !== 'published' ? `<form class="inline" method="post" action="/posts/${p.id}/publish-now"><input type="hidden" name="_csrf" value="${csrf}"><button>publish now</button></form>` : esc(p.published_at || '')}</td></tr>`
    )).join('');
    const magnetOpts = magnets.all().map((m) => `<option value="${m.id}">#${m.id} ${esc(m.name)}</option>`).join('');
    const campaignOpts = campaigns.all().map((c) => `<option value="${c.id}">#${c.id} ${esc(c.name)}</option>`).join('');
    return (
      `<h2>Posts</h2><table><tr><th>id</th><th>status</th><th>hook</th><th>trigger</th><th>preview</th><th></th></tr>${rows || '<tr><td colspan=6 class=muted>none</td></tr>'}</table>` +
      `<h2>Generate a magnet</h2><form method="post" action="/magnets/create"><input type="hidden" name="_csrf" value="${csrf}">` +
      `<select name="campaign_id"><option value="">(no campaign — env defaults)</option>${campaignOpts}</select> ` +
      `<input name="topic" placeholder="topic" size="28"> <button>Generate magnet</button></form>` +
      `<h2>Generate posts</h2><form method="post" action="/posts/create"><input type="hidden" name="_csrf" value="${csrf}">` +
      `<select name="magnet_id">${magnetOpts || '<option>(create a magnet first)</option>'}</select> ` +
      `<input name="count" type="number" value="1" min="1" max="10" style="width:60px"> ` +
      `<select name="mode"><option value="schedule">schedule (spread)</option><option value="now">publish now</option><option value="draft">draft</option></select> ` +
      `<label><input type="checkbox" name="learn" value="1"> learn (bandit)</label> <button>Generate posts</button></form>`
    );
  }

  function engagementsPage() {
    const rows = db.all(`SELECT * FROM engagements ORDER BY id DESC LIMIT 100`).map((e) => (
      `<tr><td>#${e.id}</td><td>${esc(e.name || '')}</td><td>${e.status}</td><td>${esc(e.email || '')}</td><td>${esc(e.comment_text || '').slice(0, 40)}</td><td>${e.crm_synced_at ? '✓' : ''}</td></tr>`
    )).join('');
    return `<h2>Recent engagements</h2><table><tr><th>id</th><th>name</th><th>status</th><th>email</th><th>comment</th><th>crm</th></tr>${rows || '<tr><td colspan=6 class=muted>none</td></tr>'}</table>`;
  }

  async function preflightPage() {
    const checks = await preflightChecks(config, db, {});
    const { ready, blocks, warns } = summarize(checks);
    const rows = checks.map((c) => `<tr><td class="${c.level === 'block' ? 'block' : c.level === 'warn' ? 'warn' : 'ok'}">${c.level}</td><td>${esc(c.name)}</td><td>${esc(c.detail)}</td></tr>`).join('');
    return `<h2>Go-live preflight</h2><p>${ready ? '🚀 <b class=ok>READY</b>' : '⛔ <b class=block>NOT READY</b>'} — ${blocks} blocker(s), ${warns} warning(s)</p><table><tr><th>level</th><th>check</th><th>detail</th></tr>${rows}</table>`;
  }
}
