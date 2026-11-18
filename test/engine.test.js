'use strict';
// Unit tests of what background.js does behind the scenes (completion notifications, list badges, popup),
// against a fake qBittorrent that holds a big library: the library must never be downloaded whole.
// Run with `node --test` (Node 18+, no dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const hashOf = (i) => i.toString(16).padStart(40, '0');

// `farm` torrents are seeding and tagged zen-farm; `active` ones are downloading. Torrents are added, and complete, in that order.
function library({ farm = 0, other = 0, active = 0 }) {
  const torrents = [];
  const add = (count, make) => { for (let i = 0; i < count; i++) torrents.push(make(torrents.length)); };
  add(farm, (i) => ({ hash: hashOf(i), name: `Farm.${i}.MULTI.1080p-X`, progress: 1, state: 'stalledUP', tags: 'zen-farm', category: '', added_on: i, completion_on: i }));
  add(other, (i) => ({ hash: hashOf(i), name: `Film.${i}.MULTI.1080p-Y`, progress: 1, state: 'stalledUP', tags: i % 2 ? 'radarr' : '', category: 'films', added_on: i, completion_on: i }));
  add(active, (i) => ({ hash: hashOf(i), name: `Dl.${i}.MULTI.1080p-Z`, progress: 0.5, state: 'downloading', tags: '', category: 'films', added_on: i, completion_on: -1 }));
  return torrents;
}

function engine({ torrents, config = {}, tracked = {} }) {
  const requests = [];
  const returned = [];
  const notifications = [];
  const listeners = {};
  const stores = { local: { qbUrl: 'http://qb:8080', notifyEnabled: true, notifyAll: true, listBadges: true, tracked, ...config }, session: {} };
  const clock = { now: 1_000_000 };

  const area = (data) => ({
    async get(keys) {
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (key in data) out[key] = data[key];
      return out;
    },
    async set(patch) { Object.assign(data, JSON.parse(JSON.stringify(patch))); }
  });

  const reply = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) });

  // The part of the WebUI API the engine uses.
  async function fetchQb(url) {
    const u = new URL(url);
    requests.push(u.pathname.replace('/api/v2/', '') + u.search);
    const q = u.searchParams;
    if (u.pathname === '/api/v2/torrents/tags') return reply([...new Set(torrents.flatMap((t) => (t.tags ? t.tags.split(', ') : [])))]);
    if (u.pathname === '/api/v2/transfer/info') return reply({ dl_info_speed: 5, up_info_speed: 7 });
    if (u.pathname !== '/api/v2/torrents/info') return { ok: false, status: 404, json: async () => ({}), text: async () => '' };

    let list = torrents;
    if (q.has('hashes')) { const wanted = new Set(q.get('hashes').split('|')); list = list.filter((t) => wanted.has(t.hash)); }
    if (q.get('filter') === 'downloading') list = list.filter((t) => t.progress < 1);
    if (q.get('filter') === 'completed') list = list.filter((t) => t.progress >= 1);
    if (q.has('tag')) { const tag = q.get('tag'); list = list.filter((t) => (tag === '' ? !t.tags : t.tags.split(', ').includes(tag))); }
    if (q.has('sort')) {
      const key = q.get('sort');
      list = [...list].sort((a, b) => (q.get('reverse') === 'true' ? b[key] - a[key] : a[key] - b[key]));
    }
    if (q.has('limit')) list = list.slice(0, Number(q.get('limit')));
    returned.push(list.length);
    return reply(list);
  }

  const listener = () => ({ addListener(fn) { this.fn = fn; } });
  const chrome = {
    storage: { local: area(stores.local), session: area(stores.session) },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { TAB_ID_NONE: -1, create() {}, sendMessage() {} },
    notifications: { create: (id, options) => notifications.push({ id, ...options }), clear() {}, onClicked: listener() },
    alarms: { get: (name, done) => done({}), create() {}, onAlarm: listener() },
    downloads: { cancel() {}, erase() {}, onDeterminingFilename: listener() },
    runtime: { onInstalled: listener(), onStartup: listener(), onMessage: listener() }
  };
  listeners.message = chrome.runtime.onMessage;

  class FakeDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({ chrome, fetch: fetchQb, URL, URLSearchParams, console, Date: FakeDate });
  vm.runInContext(source, context);

  return {
    requests, returned, notifications, stores, clock,
    poll: () => vm.runInContext('pollCompletions()', context),
    ask: (message) => new Promise((resolve) => { listeners.message.fn(message, { tab: { id: 1 } }, resolve); })
  };
}

const complete = (torrents, ...hashes) => {
  for (const t of torrents) if (hashes.includes(t.hash)) { t.progress = 1; t.state = 'uploading'; }
};

test('the poll lists what is downloading, never the library', async () => {
  const torrents = library({ farm: 4000, other: 100, active: 10 });
  const e = engine({ torrents });
  await e.poll();

  assert.deepEqual(e.requests, ['torrents/info?filter=downloading']);
  assert.equal(e.stores.session.incomplete.length, 10);
  assert.equal(e.notifications.length, 0);
});

test('a download that ends is looked up by hash and notified once', async () => {
  const torrents = library({ farm: 4000, active: 3 });
  const e = engine({ torrents });
  await e.poll();
  complete(torrents, hashOf(4001));
  e.requests.length = 0;
  await e.poll();

  assert.equal(e.notifications.length, 1);
  assert.equal(e.notifications[0].id, 'done:' + hashOf(4001));
  assert.match(e.notifications[0].message, /^Dl\.4001\./);
  assert.deepEqual(e.requests, ['torrents/info?filter=downloading', `torrents/info?hashes=${hashOf(4001)}`]);
  assert.ok(Math.max(...e.returned) <= 3, 'only a few torrents come back');

  await e.poll();
  assert.equal(e.notifications.length, 1, 'not notified again');
});

test('a burst of completions is summed up after three notifications', async () => {
  const torrents = library({ active: 8 });
  const e = engine({ torrents });
  await e.poll();
  complete(torrents, ...torrents.map((t) => t.hash));
  await e.poll();

  assert.equal(e.notifications.length, 4);
  assert.equal(e.notifications.filter((n) => n.id !== 'done:more').length, 3);
  assert.match(e.notifications.find((n) => n.id === 'done:more').message, /^\+ 5 autres téléchargements terminés$/);
});

test('zen-farm torrents never notify', async () => {
  const torrents = library({ active: 2 });
  torrents[0].tags = 'zen-farm';
  const e = engine({ torrents });
  await e.poll();
  complete(torrents, ...torrents.map((t) => t.hash));
  await e.poll();

  assert.deepEqual(e.notifications.map((n) => n.id), ['done:' + torrents[1].hash]);
  assert.deepEqual(e.stores.session.incomplete, []);
});

test('a torrent sent from the browser notifies even when only those are watched', async () => {
  const torrents = library({ farm: 3000, active: 1 });
  const hash = torrents[3000].hash;
  const e = engine({ torrents, config: { notifyAll: false }, tracked: { [hash]: { name: 'Dl', added: 1_000_000 } } });
  await e.poll();
  assert.equal(e.notifications.length, 0);

  complete(torrents, hash);
  e.requests.length = 0;
  await e.poll();
  assert.deepEqual(e.requests, [`torrents/info?hashes=${hash}`]);
  assert.equal(e.notifications.length, 1);
  assert.deepEqual(e.stores.local.tracked, {});
});

test('a tracked torrent removed from qBittorrent is forgotten after ten minutes', async () => {
  const e = engine({ torrents: [], config: { notifyAll: false }, tracked: { [hashOf(1)]: { name: 'x', added: 1_000_000 } } });
  await e.poll();
  assert.ok(hashOf(1) in e.stores.local.tracked);
  e.clock.now += 11 * 60000;
  await e.poll();
  assert.deepEqual(e.stores.local.tracked, {});
});

test('the list badges read a small library with one request', async () => {
  const torrents = library({ other: 50 });
  const e = engine({ torrents });
  const answer = await e.ask({ type: 'qbitIndex', hashes: [hashOf(1)] });

  assert.equal(answer.ok, true);
  assert.equal(answer.torrents.length, 50);
  assert.deepEqual(e.requests, ['torrents/info?sort=added_on&reverse=true&limit=500']);
  assert.deepEqual(Object.keys(answer.torrents[0]).sort(), ['hash', 'name', 'progress', 'state']);
});

test('the list badges leave the quiet tag of a big library out, and find the torrents of the page by hash', async () => {
  const torrents = library({ farm: 3000, other: 40, active: 2 });
  const e = engine({ torrents });
  const farmOnPage = hashOf(10);
  const answer = await e.ask({ type: 'qbitIndex', hashes: [farmOnPage, hashOf(3001), 'not-a-hash'] });

  assert.equal(answer.ok, true);
  const names = answer.torrents.map((t) => t.name);
  assert.equal(names.filter((n) => n.startsWith('Farm.')).length, 1, 'only the farm torrent shown on the page');
  assert.ok(names.includes('Farm.10.MULTI.1080p-X'));
  assert.equal(names.filter((n) => !n.startsWith('Farm.')).length, 42);
  assert.ok(!e.requests.some((r) => r.includes('tag=zen-farm')), 'the farm is not listed');
  assert.ok(Math.max(...e.returned) <= 500, 'no response holds more than a page');
  assert.ok(e.returned.reduce((a, b) => a + b, 0) < 700, 'a page and a few dozen torrents, not 3000');
});

test('the list badges reuse a listing for a moment, and again after a new one is needed', async () => {
  const torrents = library({ other: 5 });
  const e = engine({ torrents });
  await e.ask({ type: 'qbitIndex', hashes: [] });
  await e.ask({ type: 'qbitIndex', hashes: [] });
  assert.equal(e.requests.length, 1);

  e.clock.now += 31000;
  await e.ask({ type: 'qbitIndex', hashes: [] });
  assert.equal(e.requests.length, 2);
});

test('the list badges stay off when turned off', async () => {
  const e = engine({ torrents: library({ other: 5 }), config: { listBadges: false } });
  const answer = await e.ask({ type: 'qbitIndex', hashes: [] });
  assert.equal(answer.torrents.length, 0);
  assert.deepEqual(e.requests, []);
});

test('the popup shows what is downloading and the last twenty completions, with the speeds', async () => {
  const torrents = library({ farm: 3000, other: 100, active: 5 });
  torrents[3101].tags = 'zen-farm';
  const e = engine({ torrents });
  const answer = await e.ask({ type: 'listTorrents' });

  assert.equal(answer.ok, true);
  const active = answer.torrents.filter((t) => t.progress < 1);
  const done = answer.torrents.filter((t) => t.progress >= 1);
  assert.deepEqual([...active.map((t) => t.name)], ['Dl.3104.MULTI.1080p-Z', 'Dl.3103.MULTI.1080p-Z', 'Dl.3102.MULTI.1080p-Z', 'Dl.3100.MULTI.1080p-Z']);
  assert.equal(done.length, 20);
  assert.equal(done[0].name, 'Film.3099.MULTI.1080p-Y');
  assert.ok(done.every((t, i) => i === 0 || done[i - 1].completion_on > t.completion_on), 'newest first');
  assert.equal(answer.dlspeed, 5);
  assert.equal(answer.upspeed, 7);
  assert.ok(Math.max(...e.returned) <= 60, 'no response holds more than a few dozen torrents');
  assert.ok(!e.requests.some((r) => r.startsWith('torrents/tags') || r.includes('tag=')), 'one request is enough');
});

test('the popup finds the real completions behind a farm that completed in bulk', async () => {
  const farm = library({ farm: 3000 }).map((t, i) => ({ ...t, hash: hashOf(30 + i), added_on: 30 + i, completion_on: 30 + i }));
  const e = engine({ torrents: [...library({ other: 30 }), ...farm] });
  const answer = await e.ask({ type: 'listTorrents' });

  assert.equal(answer.torrents.length, 20);
  assert.ok(answer.torrents.every((t) => t.name.startsWith('Film.')));
  assert.equal(answer.torrents[0].name, 'Film.29.MULTI.1080p-Y');
  assert.ok(e.requests.some((r) => r.startsWith('torrents/tags')));
  assert.ok(!e.requests.some((r) => r.includes('tag=zen-farm')), 'the farm is not listed');
  assert.ok(Math.max(...e.returned) <= 60);
});
