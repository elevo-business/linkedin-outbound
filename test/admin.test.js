import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/db.js';
import { Campaigns } from '../src/db/campaigns.js';
import { createAdminServer } from '../src/server/adminServer.js';
import { testConfig } from './helpers.js';

function startServer(deps) {
  const config = testConfig({ server: { adminPassword: 'secret' } });
  const server = createAdminServer(config, deps);
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}
const get = (port, path, cookie) => fetch(`http://localhost:${port}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const post = (port, path, fields, cookie) =>
  fetch(`http://localhost:${port}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });

async function login(port) {
  const res = await post(port, '/login', { password: 'secret' });
  assert.equal(res.status, 302);
  const sid = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.match(sid, /^sid=/);
  return sid;
}
async function csrfFrom(port, path, cookie) {
  const html = await (await get(port, path, cookie)).text();
  return html.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
}

test('admin: requires auth and rejects wrong password', async () => {
  const { server, port } = await startServer({ db: new Db(':memory:'), runTick: async () => ({}) });
  try {
    assert.equal((await get(port, '/')).status, 302, 'unauthed -> redirect to login');
    assert.match((await (await get(port, '/login')).text()), /password/i);
    assert.equal((await post(port, '/login', { password: 'nope' })).status, 401);
  } finally {
    server.close();
  }
});

test('admin: login, view dashboard, create a campaign, CSRF enforced', async () => {
  const db = new Db(':memory:');
  const { server, port } = await startServer({ db, runTick: async () => ({ published: [1] }) });
  try {
    const sid = await login(port);

    const home = await get(port, '/', sid);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Admin/);

    // CSRF required.
    assert.equal((await post(port, '/campaigns/create', { name: 'X' }, sid)).status, 403, 'missing csrf rejected');

    // With a valid CSRF token the campaign is created.
    const csrf = await csrfFrom(port, '/campaigns', sid);
    const res = await post(port, '/campaigns/create', { name: 'DACH SaaS', icp: 'founders', trigger: 'GUIDE', _csrf: csrf }, sid);
    assert.equal(res.status, 302);
    const camps = new Campaigns(db).all();
    assert.equal(camps.length, 1);
    assert.equal(camps[0].name, 'DACH SaaS');
    assert.equal(camps[0].trigger_word, 'GUIDE');

    // Tick action is wired (runTick injected).
    const tick = await post(port, '/tick', { _csrf: csrf }, sid);
    assert.equal(tick.status, 302);
  } finally {
    server.close();
  }
});

test('admin: preflight page renders for an authed user', async () => {
  const { server, port } = await startServer({ db: new Db(':memory:'), runTick: async () => ({}) });
  try {
    const sid = await login(port);
    const html = await (await get(port, '/preflight', sid)).text();
    assert.match(html, /preflight/i);
    assert.match(html, /NOT READY|READY/);
  } finally {
    server.close();
  }
});
