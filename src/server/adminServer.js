// Password-protected admin dashboard (built-in http, no deps).
//
// Designed to be SIMPLE and approval-first: you create a campaign (your ICP),
// generate draft posts, and REVIEW each one as a LinkedIn-style preview before
// anything goes out — approve, edit, regenerate, or discard. Nothing publishes
// without your approval.
//
// Auth: ADMIN_PASSWORD + in-memory session cookie. Forms carry a CSRF token.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Db } from '../db/db.js';
import { Campaigns } from '../db/campaigns.js';
import { Magnets } from '../db/magnets.js';
import { Posts, POST_STATUS } from '../db/posts.js';
import { Engagements } from '../db/engagements.js';
import { breakerActive } from '../core/breaker.js';
import { ContentGenerator, POST_HOOKS } from '../inbound/contentGenerator.js';
import { createImageClient, generatePostImage } from '../image/index.js';
import { preflightChecks, summarize } from '../preflight.js';

const DAY = 24 * 3600 * 1000;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => r(d)); });
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const timingEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const randHook = () => POST_HOOKS[Math.floor(Math.random() * POST_HOOKS.length)];

const STYLE = `
*{box-sizing:border-box}body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:18px;color:#16181c;background:#f6f8fa}
h1{font-size:20px;margin:.2em 0}h2{font-size:15px;color:#555;text-transform:uppercase;letter-spacing:.04em;margin:26px 0 10px}
a{color:#0a66c2;text-decoration:none}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
nav{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 18px}
nav a{padding:7px 14px;border-radius:20px;background:#fff;border:1px solid #e3e6ea;font-size:14px}
nav a.on{background:#0a66c2;color:#fff;border-color:#0a66c2}
.badge{background:#e8463a;color:#fff;border-radius:10px;padding:0 7px;font-size:12px;margin-left:5px}
input,select,textarea,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #ccd2d8;background:#fff}
textarea{width:100%;min-height:120px}button{background:#0a66c2;color:#fff;border:0;cursor:pointer;font-weight:600}
button.ghost{background:#fff;color:#0a66c2;border:1px solid #ccd6e0;font-weight:500}button.danger{background:#fff;color:#b00020;border:1px solid #e6c2c8;font-weight:500}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:0;margin:14px 0;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.card .meta{padding:10px 16px;background:#fafbfc;border-bottom:1px solid #eef1f4;font-size:13px;color:#555;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chip{background:#eef3f8;color:#0a66c2;border-radius:14px;padding:2px 10px;font-size:12px;font-weight:600}
.post{padding:16px}.post .author{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.post .avatar{width:42px;height:42px;border-radius:50%;background:#0a66c2;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.post .body{white-space:normal}.post .promo{margin-top:12px;font-size:13px;color:#666;border-top:1px dashed #e3e6ea;padding-top:8px}
.actions{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid #eef1f4;background:#fafbfc}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.stat{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:14px 16px;flex:1;min-width:120px}
.stat b{font-size:24px;display:block}.muted{color:#8a9099}.ok{color:#0a7d32}.block{color:#b00020}.warn{color:#9a6b00}
form.inline{display:inline}details{margin-top:8px}summary{cursor:pointer;color:#0a66c2;font-size:14px}
.hint{background:#fff7e6;border:1px solid #ffe2a8;border-radius:10px;padding:10px 14px;font-size:14px;margin:10px 0}
.flash{background:#e9f7ee;border:1px solid #b6e2c4;border-radius:10px;padding:10px 14px;margin:10px 0}
`;

function layout(active, body, { csrf, flash, drafts }) {
  const link = (href, label, extra = '') =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${label}${extra}</a>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>LinkedIn Maschine</title><style>${STYLE}</style></head><body>` +
    `<div class="top"><h1>🦾 LinkedIn Maschine</h1>` +
    `<form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="ghost">Logout</button></form></div>` +
    `<nav>${link('/', 'Start')}${link('/review', 'Freigabe', drafts ? `<span class="badge">${drafts}</span>` : '')}${link('/campaigns', 'Zielgruppen')}${link('/leads', 'Leads')}${link('/setup', 'Setup')}</nav>` +
    (flash ? `<div class="flash">${esc(flash)}</div>` : '') +
    body +
    `</body></html>`
  );
}

function loginPage(error, hasPassword) {
  return (
    `<!doctype html><meta charset="utf-8"><title>Login</title><style>${STYLE}</style>` +
    `<body style="max-width:340px;margin-top:14vh"><h1>🦾 LinkedIn Maschine</h1>` +
    (hasPassword ? '' : `<div class="hint">ADMIN_PASSWORD ist nicht gesetzt — in Coolify/.env setzen, um den Login zu aktivieren.</div>`) +
    (error ? `<div class="hint" style="background:#fde8e8;border-color:#f5b5b5">${esc(error)}</div>` : '') +
    `<form method="post" action="/login"><input type="password" name="password" placeholder="Passwort" autofocus style="width:100%">` +
    `<button style="width:100%;margin-top:8px">Einloggen</button></form></body>`
  );
}

export function createAdminServer(config, deps = {}) {
  const db = deps.db || new Db(config.dbPath);
  const campaigns = new Campaigns(db);
  const magnets = new Magnets(db);
  const posts = new Posts(db);
  const engagements = new Engagements(db);
  const gen = deps.contentGenerator || new ContentGenerator(config, () => {});
  const imagePromise = deps.image ? Promise.resolve(deps.image) : createImageClient(config, () => {});
  const runTick = deps.runTick || (async () => {
    const { buildInbound } = await import('../inboundRunner.js');
    const built = await buildInbound(config, () => {});
    try {
      const login = await built.client.login();
      if (!login.ok) return { skipped: `login failed: ${login.error}` };
      return await built.sequencer.tick();
    } finally { await built.client.close(); }
  });

  const sessions = new Map();
  const newSession = () => { const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, { csrf: crypto.randomBytes(16).toString('hex') }); return sid; };
  const draftCount = () => posts.byStatus(POST_STATUS.DRAFT).length;

  // Ensure a campaign has a magnet (auto-create from its first topic), return it.
  async function ensureMagnet(campaign) {
    let m = magnets.byCampaign(campaign.id);
    if (m) return m;
    const topic = campaigns.topicsList(campaign)[0] || campaign.icp || 'your topic';
    const data = await gen.magnet(topic, campaign);
    const id = magnets.create({ ...data, campaign_id: campaign.id, delivery: campaign.delivery });
    return magnets.byId(id);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (code, html, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
    const redirect = (to, cookie) => { const h = { location: to }; if (cookie) h['set-cookie'] = cookie; res.writeHead(302, h); res.end(); };
    const back = (m) => redirect(`${url.pathname.split('/').slice(0, 2).join('/') || '/'}?m=${encodeURIComponent(m)}`);
    try {
      const cookies = parseCookies(req);
      const session = sessions.get(cookies.sid);
      const body = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : null;

      if (url.pathname === '/login') {
        if (req.method === 'GET') return send(200, loginPage(null, Boolean(config.server.adminPassword)));
        if (!config.server.adminPassword) return send(200, loginPage('Kein Passwort konfiguriert.', false));
        if (timingEq(body.get('password') || '', config.server.adminPassword)) return redirect('/', `sid=${newSession()}; HttpOnly; SameSite=Lax; Path=/`);
        return send(401, loginPage('Falsches Passwort.', true));
      }
      if (!session) return redirect('/login');
      if (req.method === 'POST') {
        if ((body.get('_csrf') || '') !== session.csrf) return send(403, 'bad csrf');
        if (url.pathname === '/logout') { sessions.delete(cookies.sid); return redirect('/login', 'sid=; Max-Age=0; Path=/'); }
      }
      const csrf = session.csrf;
      const flash = url.searchParams.get('m');
      const wrap = (active, bodyHtml) => layout(active, bodyHtml, { csrf, flash, drafts: draftCount() });

      // ---------- actions ----------
      if (req.method === 'POST') {
        let m;
        if (url.pathname === '/campaigns/create') {
          campaigns.create({
            name: body.get('name') || 'Unbenannt', icp: body.get('icp'), topics: body.get('topics'),
            trigger_word: body.get('trigger') || config.inbound.triggerWord, delivery: body.get('delivery') || 'dm',
            value_prop: body.get('value_prop'), sender_name: body.get('sender_name'), sender_role: body.get('sender_role'),
            language: body.get('language') || config.content.language,
          });
          return redirect('/campaigns?m=' + encodeURIComponent('Zielgruppe angelegt.'));
        }
        if ((m = url.pathname.match(/^\/campaigns\/(\d+)\/(pause|activate)$/))) {
          campaigns.setStatus(Number(m[1]), m[2] === 'pause' ? 'paused' : 'active');
          return redirect('/campaigns?m=ok');
        }
        if ((m = url.pathname.match(/^\/campaigns\/(\d+)\/generate$/))) {
          const campaign = campaigns.byId(Number(m[1]));
          if (campaign) {
            const magnet = await ensureMagnet(campaign);
            const count = Math.min(8, Math.max(1, Number(body.get('count') || 3)));
            for (let i = 0; i < count; i++) {
              const p = await gen.post(magnet, POST_HOOKS[i % POST_HOOKS.length], campaign);
              posts.create({ campaign_id: campaign.id, magnet_id: magnet.id, status: POST_STATUS.DRAFT, body: p.body, hook: p.hook, trigger_word: p.trigger_word });
            }
            return redirect('/review?m=' + encodeURIComponent(`${count} Entwürfe erstellt — bitte prüfen.`));
          }
          return redirect('/campaigns?m=not+found');
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/approve$/))) {
          posts.schedule(Number(m[1]), new Date().toISOString());
          return redirect('/review?m=' + encodeURIComponent('Freigegeben — geht beim nächsten Lauf raus (oder „Jetzt veröffentlichen" auf Start).'));
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/schedule$/))) {
          const at = body.get('at') ? new Date(body.get('at')).toISOString() : new Date().toISOString();
          posts.schedule(Number(m[1]), at);
          return redirect('/review?m=' + encodeURIComponent('Geplant.'));
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/edit$/))) {
          posts.updateBody(Number(m[1]), body.get('body') || '');
          return redirect('/review?m=' + encodeURIComponent('Gespeichert.'));
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/regenerate$/))) {
          const post = posts.byId(Number(m[1]));
          if (post) {
            const magnet = post.magnet_id ? magnets.byId(post.magnet_id) : null;
            const campaign = post.campaign_id ? campaigns.byId(post.campaign_id) : null;
            const np = await gen.post(magnet || { name: 'the resource', description: '', cta: '' }, randHook(), campaign);
            posts.updateBody(post.id, np.body);
          }
          return redirect('/review?m=' + encodeURIComponent('Neu generiert.'));
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/discard$/))) {
          posts.remove(Number(m[1]));
          return redirect('/review?m=' + encodeURIComponent('Verworfen.'));
        }
        if ((m = url.pathname.match(/^\/posts\/(\d+)\/image$/))) {
          const post = posts.byId(Number(m[1]));
          const image = await imagePromise;
          if (!post) return redirect('/review?m=not+found');
          if (!image.enabled) return redirect('/review?m=' + encodeURIComponent('Kein Bild-Anbieter konfiguriert (IMAGE_PROVIDER).'));
          const magnet = post.magnet_id ? magnets.byId(post.magnet_id) : null;
          const campaign = post.campaign_id ? campaigns.byId(post.campaign_id) : null;
          const r = await generatePostImage({ image, contentGenerator: gen, config, post, magnet, campaign });
          if (r.ok) {
            posts.setImage(post.id, r.path, r.brief);
            return redirect('/review?m=' + encodeURIComponent('Bild generiert.'));
          }
          return redirect('/review?m=' + encodeURIComponent('Bild fehlgeschlagen: ' + (r.error || '')));
        }
        if (url.pathname === '/tick') {
          const s = await runTick();
          return redirect('/?m=' + encodeURIComponent('Lauf ausgeführt: ' + JSON.stringify(s).slice(0, 140)));
        }
        return send(404, 'unknown action');
      }

      // ---------- image serving ----------
      let im;
      if ((im = url.pathname.match(/^\/image\/(\d+)$/))) {
        const post = posts.byId(Number(im[1]));
        if (post?.image_path && fs.existsSync(post.image_path)) {
          res.writeHead(200, { 'content-type': 'image/png' });
          return res.end(fs.readFileSync(post.image_path));
        }
        return send(404, 'text/plain', 'not found');
      }

      // ---------- pages ----------
      if (url.pathname === '/') return send(200, wrap('/', homePage(csrf)));
      if (url.pathname === '/review') return send(200, wrap('/review', reviewPage(csrf)));
      if (url.pathname === '/campaigns') return send(200, wrap('/campaigns', campaignsPage(csrf)));
      if (url.pathname === '/leads') return send(200, wrap('/leads', leadsPage()));
      if (url.pathname === '/setup') return send(200, wrap('/setup', await setupPage(csrf)));
      return send(404, 'Not found');
    } catch (err) {
      (deps.logger || console.error)(`[admin] ${err.stack || err.message}`);
      res.writeHead(500); res.end('Server error');
    }
  });

  // ---------- renderers ----------
  function homePage(csrf) {
    const now = new Date();
    const ec = engagements.counts();
    const live = (posts.counts().published || 0);
    const drafts = draftCount();
    const breaker = breakerActive(db, config, now);
    const stat = (n, l, cls = '') => `<div class="stat"><b class="${cls}">${n}</b>${l}</div>`;
    return (
      `<div class="hint">So funktioniert's: <b>1.</b> Zielgruppe anlegen → <b>2.</b> Entwürfe generieren → <b>3.</b> hier in der <a href="/review">Freigabe</a> prüfen & freigeben. Erst dann geht etwas raus.</div>` +
      `<div class="row">` +
      stat(drafts, 'Entwürfe zu prüfen', drafts ? 'warn' : '') +
      stat(live, 'Posts veröffentlicht') +
      stat((ec.delivered || 0) + (ec.dm_sent || 0) + (ec.replied || 0) + (ec.done || 0), 'Leads erfasst') +
      stat(ec.replied || 0, 'Antworten', 'ok') +
      `</div>` +
      `<p style="margin-top:14px">Status: <b class="${breaker ? 'block' : 'ok'}">${breaker ? '🛑 Pausiert (Checkpoint erkannt)' : '✅ Läuft'}</b> · LinkedIn: <b>${esc(config.driver)}</b> · CRM: <b>${esc(config.crm.provider)}</b></p>` +
      `<div class="row" style="margin-top:14px">` +
      `<a href="/campaigns"><button class="ghost">+ Neue Zielgruppe</button></a>` +
      (drafts ? `<a href="/review"><button>${drafts} Entwürfe prüfen →</button></a>` : '') +
      `<form class="inline" method="post" action="/tick"><input type="hidden" name="_csrf" value="${csrf}"><button class="ghost">▶ Jetzt veröffentlichen (Lauf)</button></form>` +
      `</div>` +
      `<p class="muted" style="margin-top:8px;font-size:13px">„Jetzt veröffentlichen" sendet freigegebene & fällige Posts sofort raus — alle Sicherheits-Limits gelten.</p>`
    );
  }

  function postCard(post, csrf) {
    const campaign = post.campaign_id ? campaigns.byId(post.campaign_id) : null;
    const magnet = post.magnet_id ? magnets.byId(post.magnet_id) : null;
    const author = campaign?.sender_name || config.personalizer.senderName || 'Du';
    const initials = author.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    return (
      `<div class="card">` +
      `<div class="meta"><span class="chip">${esc(campaign?.name || 'Ohne Zielgruppe')}</span>` +
      `<span>🎯 ${esc(campaign?.icp || config.inbound.icp || '—')}</span>` +
      `<span class="muted">· Hook: ${esc(post.hook || '—')}</span></div>` +
      `<div class="post"><div class="author"><div class="avatar">${esc(initials || '🙂')}</div>` +
      `<div><b>${esc(author)}</b><br><span class="muted" style="font-size:13px">${esc(campaign?.sender_role || config.personalizer.senderRole || '')}</span></div></div>` +
      `<div class="body">${nl2br(post.body)}</div>` +
      (post.image_path ? `<img src="/image/${post.id}" alt="" style="max-width:100%;border-radius:8px;margin-top:12px">` : '') +
      (magnet ? `<div class="promo">📎 Bewirbt: <b>${esc(magnet.name)}</b> · Kommentar-Wort: <b>${esc(post.trigger_word || '')}</b> · Auslieferung: ${esc(magnet.delivery)}</div>` : '') +
      `</div>` +
      `<div class="actions">` +
      `<form class="inline" method="post" action="/posts/${post.id}/approve"><input type="hidden" name="_csrf" value="${csrf}"><button>✅ Freigeben & veröffentlichen</button></form>` +
      `<form class="inline" method="post" action="/posts/${post.id}/regenerate"><input type="hidden" name="_csrf" value="${csrf}"><button class="ghost">🔄 Text neu</button></form>` +
      (config.image.provider !== 'none' ? `<form class="inline" method="post" action="/posts/${post.id}/image"><input type="hidden" name="_csrf" value="${csrf}"><button class="ghost">🖼 ${post.image_path ? 'Bild neu' : 'Bild generieren'}</button></form>` : '') +
      `<form class="inline" method="post" action="/posts/${post.id}/discard"><input type="hidden" name="_csrf" value="${csrf}"><button class="danger">🗑 Verwerfen</button></form>` +
      `</div>` +
      `<details style="padding:0 16px 14px"><summary>✏️ Bearbeiten / später planen</summary>` +
      `<form method="post" action="/posts/${post.id}/edit"><input type="hidden" name="_csrf" value="${csrf}"><textarea name="body">${esc(post.body)}</textarea><button class="ghost">Speichern</button></form>` +
      `<form method="post" action="/posts/${post.id}/schedule" style="margin-top:8px"><input type="hidden" name="_csrf" value="${csrf}"><input type="datetime-local" name="at"> <button class="ghost">Für später planen</button></form>` +
      `</details></div>`
    );
  }

  function reviewPage(csrf) {
    const drafts = posts.byStatus(POST_STATUS.DRAFT);
    if (!drafts.length) {
      return `<div class="hint">Keine Entwürfe zu prüfen. Lege eine <a href="/campaigns">Zielgruppe</a> an und generiere Entwürfe.</div>`;
    }
    return `<h2>Diese Posts warten auf deine Freigabe (${drafts.length})</h2>` + drafts.map((p) => postCard(p, csrf)).join('');
  }

  function campaignsPage(csrf) {
    const cards = campaigns.all().map((c) => {
      const mags = magnets.byCampaign(c.id);
      return (
        `<div class="card"><div class="post">` +
        `<div class="row"><b style="font-size:17px">${esc(c.name)}</b><span class="chip">${c.status}</span></div>` +
        `<p>🎯 <b>${esc(c.icp || '—')}</b></p>` +
        `<p class="muted" style="font-size:14px">Themen: ${esc(c.topics || '—')} · Kommentar-Wort: <b>${esc(c.trigger_word || '—')}</b> · Auslieferung: ${esc(c.delivery)}${mags ? ` · Magnet: ${esc(mags.name)}` : ''}</p>` +
        `<div class="row" style="margin-top:8px">` +
        `<form class="inline" method="post" action="/campaigns/${c.id}/generate"><input type="hidden" name="_csrf" value="${csrf}"><input type="number" name="count" value="3" min="1" max="8" style="width:64px"> <button>Entwürfe generieren</button></form>` +
        `<form class="inline" method="post" action="/campaigns/${c.id}/${c.status === 'active' ? 'pause' : 'activate'}"><input type="hidden" name="_csrf" value="${csrf}"><button class="ghost">${c.status === 'active' ? 'Pausieren' : 'Aktivieren'}</button></form>` +
        `</div></div></div>`
      );
    }).join('') || `<div class="hint">Noch keine Zielgruppe. Lege unten deine erste an.</div>`;
    return (
      `<h2>Deine Zielgruppen (ICP)</h2>${cards}` +
      `<h2>Neue Zielgruppe</h2><div class="card"><div class="post">` +
      `<form method="post" action="/campaigns/create"><input type="hidden" name="_csrf" value="${csrf}">` +
      `<label>Name</label><br><input name="name" placeholder="z.B. DACH SaaS Gründer" required style="width:100%"><br><br>` +
      `<label>Wen willst du erreichen? (ICP)</label><br><input name="icp" placeholder="z.B. B2B SaaS Gründer in DACH, 10–50 MA" style="width:100%"><br><br>` +
      `<label>Themen (Komma)</label><br><input name="topics" placeholder="z.B. outbound, deliverability, lead gen" style="width:100%"><br><br>` +
      `<div class="row"><div><label>Kommentar-Wort</label><br><input name="trigger" placeholder="z.B. GUIDE"></div>` +
      `<div><label>Auslieferung</label><br><select name="delivery"><option value="dm">DM (Link im Chat)</option><option value="gated">Gated (E-Mail-Seite)</option></select></div>` +
      `<div><label>Sprache</label><br><input name="language" placeholder="z.B. German" value="${esc(config.content.language)}"></div></div><br>` +
      `<label>Was machst du? (für die Tonalität)</label><br><input name="value_prop" placeholder="z.B. wir buchen Demos für SaaS-Teams" style="width:100%"><br><br>` +
      `<div class="row"><div><label>Dein Name</label><br><input name="sender_name" placeholder="Mert"></div>` +
      `<div><label>Deine Rolle</label><br><input name="sender_role" placeholder="Founder"></div></div><br>` +
      `<button>Zielgruppe anlegen</button></form></div></div>`
    );
  }

  function leadsPage() {
    const rows = db.all(`SELECT * FROM engagements ORDER BY id DESC LIMIT 100`).map((e) => (
      `<tr><td>${esc(e.name || '—')}</td><td>${esc(e.status)}</td><td>${esc(e.email || '')}</td><td class="muted">${esc((e.comment_text || '').slice(0, 50))}</td><td>${e.crm_synced_at ? '✅' : ''}</td></tr>`
    )).join('');
    return (
      `<h2>Eingehende Leads</h2>` +
      (rows
        ? `<div class="card"><div style="padding:6px 12px"><table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#888"><th>Name</th><th>Status</th><th>E-Mail</th><th>Kommentar</th><th>CRM</th></tr>${rows}</table></div></div>`
        : `<div class="hint">Noch keine Leads. Sobald Posts live sind und Leute mit dem Kommentar-Wort reagieren, erscheinen sie hier (und in Pipedrive).</div>`)
    );
  }

  async function setupPage(csrf) {
    const checks = await preflightChecks(config, db, {});
    const { ready, blocks, warns } = summarize(checks);
    const rows = checks.map((c) => `<tr><td>${c.level === 'block' ? '❌' : c.level === 'warn' ? '🟡' : '✅'}</td><td>${esc(c.name)}</td><td class="muted">${esc(c.detail)}</td></tr>`).join('');
    return (
      `<div class="hint">${ready ? '🚀 <b>Bereit</b> — du kannst den ersten Post freigeben.' : `⛔ <b>Noch nicht bereit</b> — ${blocks} Blocker, ${warns} Hinweise. Behebe die ❌ unten.`}</div>` +
      `<div class="card"><div style="padding:6px 12px"><table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table></div></div>` +
      `<form method="post" action="/tick" style="margin-top:14px"><input type="hidden" name="_csrf" value="${csrf}"><button class="ghost">▶ Lauf testen</button></form>`
    );
  }
}
