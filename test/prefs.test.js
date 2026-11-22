'use strict';
// The score settings (presets and weights), the free-space hint of the send dialog and the update notice of the popup:
// the engine's answers against a fake qBittorrent, and the blocks of content.js and popup.js that need no DOM.
// Run with `node --test` (Node 18+, no dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const backgroundSource = read('background.js');
const contentSource = read('content.js');
const popupSource = read('popup.js');

// What sits between `// ==== name:begin ====` and `// ==== name:end ====`: the part of a script that needs no DOM.
function between(source, name) {
  const begin = source.indexOf(`// ==== ${name}:begin ====`);
  const end = source.indexOf(`// ==== ${name}:end ====`);
  assert.ok(begin !== -1 && end > begin, `${name} markers not found`);
  return source.slice(begin, end);
}

const { parseRelease, scoreGroup, explain, cleanWeights, WEIGHTS } = new Function(
  between(contentSource, 'scoring') + '\nreturn { parseRelease, scoreGroup, explain, cleanWeights, WEIGHTS };')();
const { formatBytes, spaceNote, GIB } = new Function(
  between(contentSource, 'space') + '\nreturn { formatBytes, spaceNote, GIB };')();
const buildProfile = new Function('send', 'refreshScores', 'cleanWeights', 'scoreGroup', 'WEIGHTS', 'console',
  between(contentSource, 'profile') + '\nreturn { loadProfile, scoreWithProfile, current: () => profile, start: () => { scoringStarted = true; } };');
const buildUpdater = new Function('$', 'chrome', 'fetch',
  between(popupSource, 'version') + '\nreturn { isNewer, checkUpdate };');

const PAGE = { tab: { id: 1 }, url: 'https://c411.org/torrents' };
const SHIM = { tab: { id: 0 } }; // what the shims of Android and Desktop give every message

// What went through a vm boundary or a store is compared as plain data.
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

const reply = (body, status = 200) => ({
  ok: status < 400, status, type: 'basic',
  json: async () => plain(body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

// `route({ url, u, opts })` answers like the servers would.
function engine({ config = {}, route = () => reply([]) } = {}) {
  const requests = [];
  const stores = { local: { qbUrl: 'http://qb:8080', username: 'u', password: 'p', notifyEnabled: false, ...config }, session: {} };

  const area = (data) => ({
    async get(keys) {
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (key in data) out[key] = data[key];
      return out;
    },
    async set(patch) { Object.assign(data, plain(patch)); }
  });

  const fetchMock = async (url, opts = {}) => {
    const request = { url: String(url), opts };
    requests.push(request);
    return route({ ...request, u: new URL(url) });
  };

  const listener = () => ({ addListener(fn) { this.fn = fn; } });
  const chrome = {
    storage: { local: area(stores.local), session: area(stores.session) },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { TAB_ID_NONE: -1, create() {}, sendMessage() {} },
    notifications: { create() {}, clear() {}, onClicked: listener() },
    alarms: { get: (name, done) => done({}), create() {}, onAlarm: listener() },
    downloads: { cancel: (id, done) => done && done(), erase() {}, onDeterminingFilename: listener() },
    runtime: { onInstalled: listener(), onStartup: listener(), onMessage: listener() }
  };

  const context = vm.createContext({
    chrome, fetch: fetchMock, URL, URLSearchParams, console, atob, Blob, FormData, crypto: webcrypto, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(backgroundSource, context);

  return {
    requests, stores,
    run: (code) => vm.runInContext(code, context),
    ask: (message, sender = PAGE) => new Promise((resolve) => {
      chrome.runtime.onMessage.fn(message, sender, (response) => resolve(plain(response)));
    })
  };
}

const refused = (res, pattern = /^Requête refusée/) => {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.error, pattern);
};

const HANG = Symbol('a server that never answers');
const SPACE = '/api/v2/app/getFreeSpaceAtPath';

// A fake qBittorrent: its categories, its default save path and, for each path, what it says of the free space: a number of
// bytes, a raw answer, HANG, or a function giving the response. spaceStatus: the status of every free-space lookup.
function fakeQb({ categories = {}, defaultPath = '/data/dl', free = {}, spaceStatus = 200 } = {}) {
  const answer = (value, ctx) => {
    if (value === HANG) return new Promise(() => {});
    return typeof value === 'function' ? value(ctx) : reply(String(value));
  };
  return (ctx) => {
    const { u } = ctx;
    if (u.pathname === '/api/v2/torrents/categories') return reply(categories);
    if (u.pathname === '/api/v2/app/defaultSavePath') return answer(defaultPath, ctx);
    if (u.pathname === SPACE) {
      if (spaceStatus !== 200) return reply('', spaceStatus);
      const asked = u.searchParams.get('path');
      return Object.prototype.hasOwnProperty.call(free, asked) ? answer(free[asked], ctx) : reply('', 500);
    }
    return reply('', 404);
  };
}
const spaceRequests = (e) => e.requests.filter((r) => new URL(r.url).pathname === SPACE);
const askedPaths = (e) => spaceRequests(e).map((r) => new URL(r.url).searchParams.get('path'));
const CATEGORIES = { films: { savePath: '/data/films' }, tv: { savePath: '/data/tv' }, misc: { savePath: '' } };

const EQUILIBRE = { lang: 30, quality: 30, health: 20, size: 20 };
const DEFAULT = { preset: 'equilibre', weights: EQUILIBRE };
const base = engine();
const scorePrefs = (cfg) => plain(base.run('scorePrefs')(cfg));
const weightsOf = (preset) => scorePrefs({ scorePreset: preset }).weights;

// ---------- the presets ----------

test('the default preset is the historical score, and the presets are the ones of the settings', () => {
  assert.deepEqual(scorePrefs({}), DEFAULT);
  assert.deepEqual(WEIGHTS, EQUILIBRE, 'the page scores the same before the engine has answered');
  for (const id of ['equilibre', 'qualite', 'vf', 'leger', 'ratio']) {
    const prefs = scorePrefs({ scorePreset: id, scoreWeights: { lang: 1, quality: 1, health: 1, size: 1 } });
    assert.equal(prefs.preset, id);
    assert.equal(Object.values(prefs.weights).reduce((sum, w) => sum + w, 0), 100, `${id} adds up to 100`);
    assert.deepEqual(Object.keys(prefs.weights).sort(), ['health', 'lang', 'quality', 'size']);
  }
  const all = ['equilibre', 'qualite', 'vf', 'leger', 'ratio'].map((id) => JSON.stringify(weightsOf(id)));
  assert.equal(new Set(all).size, 5, 'each preset has its own weights');
  assert.deepEqual(weightsOf('equilibre'), EQUILIBRE);
});

test('an unknown or unusable preset is equilibre, whatever the saved weights are', () => {
  const weights = { lang: 100, quality: 0, health: 0, size: 0 };
  for (const scorePreset of ['nope', '', ' vf', 'VF', '__proto__', 'constructor', 'toString', 42, null, true, ['vf'], { vf: 1 }]) {
    assert.deepEqual(scorePrefs({ scorePreset, scoreWeights: weights }), DEFAULT, String(scorePreset));
  }
  for (const cfg of [undefined, null, {}, 'x', 7, [], { scorePreset: undefined }]) assert.deepEqual(scorePrefs(cfg), DEFAULT, String(cfg));
});

test('perso uses the saved weights as whole numbers from 0 to 100', () => {
  const perso = (scoreWeights) => scorePrefs({ scorePreset: 'perso', scoreWeights });
  const saved = { lang: 10, quality: 20, health: 30, size: 40 };
  assert.deepEqual(perso(saved), { preset: 'perso', weights: saved });
  assert.deepEqual(perso({ lang: 150, quality: -5, health: 12.6, size: '40' }).weights, { lang: 100, quality: 0, health: 13, size: 40 });

  // A part that is missing or not a number keeps the weight of equilibre; no saved weights at all start from equilibre.
  assert.deepEqual(perso({ lang: 80 }).weights, { lang: 80, quality: 30, health: 20, size: 20 });
  assert.deepEqual(perso({ lang: 'abc', quality: NaN, health: Infinity, size: null }), { preset: 'perso', weights: EQUILIBRE });
  for (const none of [undefined, null, 'x', 7, [1, 2, 3, 4]]) assert.deepEqual(perso(none), { preset: 'perso', weights: EQUILIBRE });

  // All at 0 (also once rounded) cannot score anything: equilibre. A single weight is enough.
  for (const zero of [{ lang: 0, quality: 0, health: 0, size: 0 }, { lang: -3, quality: 0.2, health: '0', size: -100 }]) {
    assert.deepEqual(perso(zero), DEFAULT);
  }
  assert.deepEqual(perso({ lang: 0, quality: 0, health: 1, size: 0 }), { preset: 'perso', weights: { lang: 0, quality: 0, health: 1, size: 0 } });

  const run = base.run('scorePrefs');
  run({}).weights.lang = 1;
  assert.equal(run({}).weights.lang, 30, 'every answer is a copy');
});

test('pagePrefs takes nothing from the page, and getCategories only a withSpace flag', async () => {
  const clean = (message, sender = PAGE) => plain(base.run('cleanPageMessage')(message, sender));
  assert.deepEqual(clean({ type: 'pagePrefs', scorePreset: 'vf', scoreWeights: { lang: 100 }, extra: 1 }), { type: 'pagePrefs' });
  assert.deepEqual(clean({ type: 'getCategories' }), { type: 'getCategories', withSpace: false });
  assert.deepEqual(clean({ type: 'getCategories', withSpace: null }), { type: 'getCategories', withSpace: false });
  assert.deepEqual(clean({ type: 'getCategories', withSpace: true, path: '/etc', cfg: {} }), { type: 'getCategories', withSpace: true });
  assert.deepEqual(clean({ type: 'getCategories', withSpace: true }, SHIM), { type: 'getCategories', withSpace: true });

  const e = engine({ route: fakeQb({ categories: CATEGORIES }) });
  for (const withSpace of ['yes', 'true', 1, 0, {}, []]) refused(await e.ask({ type: 'getCategories', withSpace }), /espace disque invalide/);
  assert.deepEqual(e.requests, [], 'nothing was asked of qBittorrent');
});

test('pagePrefs answers the score settings to the page and to the shims, with no request', async () => {
  const perso = { lang: 10, quality: 20, health: 30, size: 40 };
  const configs = [
    [{}, DEFAULT],
    [{ scorePreset: 'vf' }, { preset: 'vf', weights: weightsOf('vf') }],
    [{ scorePreset: 'perso', scoreWeights: perso }, { preset: 'perso', weights: perso }],
    [{ scorePreset: 'unknown', scoreWeights: perso }, DEFAULT]
  ];
  for (const [config, score] of configs) {
    const e = engine({ config });
    // The page cannot choose its own settings.
    for (const sender of [PAGE, SHIM]) assert.deepEqual(await e.ask({ type: 'pagePrefs', scorePreset: 'ratio' }, sender), { ok: true, score });
    assert.deepEqual(e.requests, []);
  }
});

// ---------- the score with the weights ----------

const entry = (name, sizeGB, seeders) => ({ release: parseRelease(name), sizeGB, seeders });
// One film, five torrents: a Remux 2160p (A), compact encodes (B, E), a tiny HDLight (C) and a VFQ with 900 seeders (D).
const LINEUP = [
  ['A', 'Film.2020.MULTI.2160p.BluRay.REMUX.HDR10.DTS-HD.MA.x265-A', 80, 12],
  ['B', 'Film.2020.MULTI.VFF.1080p.WEB.x264-B', 6, 25],
  ['C', 'Film.2020.VFQ.1080p.HDLight.x265-C', 1.5, 30],
  ['D', 'Film.2020.VFQ.1080p.WEB.x264-D', 14, 900],
  ['E', 'Film.2020.MULTI.VF2.1080p.BluRay.x265-E', 12, 20]
];
const lineup = (seeders = true) => LINEUP.map(([, name, size, seeded]) => entry(name, size, seeders ? seeded : null));
const standings = (weights) => {
  const group = scoreGroup(lineup(), weights);
  const score = Object.fromEntries(LINEUP.map(([id], i) => [id, group.rows[i].score]));
  return { score, best: LINEUP[group.rows.findIndex((row) => row.awards.includes('best'))][0] };
};

test('without weights, with the equilibre ones or with unusable ones, the score is the historical one', () => {
  const historical = scoreGroup(lineup());
  assert.deepEqual(historical.max, EQUILIBRE);
  assert.deepEqual(scoreGroup(lineup(), EQUILIBRE), historical);
  assert.deepEqual(scoreGroup(lineup(), weightsOf('equilibre')), historical);
  const unusable = [undefined, null, {}, [], 'x', 42, { lang: 1 }, { lang: '30', quality: '30', health: '20', size: '20' },
    { lang: NaN, quality: 30, health: 20, size: 20 }, { lang: Infinity, quality: 30, health: 20, size: 20 },
    { lang: 0, quality: 0, health: 0, size: 0 }];
  for (const wanted of unusable) assert.deepEqual(scoreGroup(lineup(), wanted), historical, JSON.stringify(wanted));
  assert.deepEqual(cleanWeights({ lang: 150, quality: -5, health: 10, size: 10 }), { lang: 100, quality: 0, health: 10, size: 10 });
});

test('each preset moves the ranking towards what it is named after', () => {
  const equilibre = standings(weightsOf('equilibre'));
  assert.equal(equilibre.best, 'B', 'the compact MULTI.VFF encode');

  // How much more the first torrent is worth over the second under a preset than under equilibre.
  const shift = (preset, first, second) => {
    const s = standings(weightsOf(preset));
    return (s.score[first] - s.score[second]) - (equilibre.score[first] - equilibre.score[second]);
  };
  const qualite = standings(weightsOf('qualite'));
  assert.equal(qualite.best, 'A', 'the Remux 2160p');
  assert.ok(shift('qualite', 'A', 'B') >= 15, 'qualite: the Remux over the compact encode');
  assert.ok(shift('vf', 'E', 'C') >= 15, 'vf: MULTI.VF2 over VFQ');
  assert.equal(standings(weightsOf('leger')).best, 'C', 'the 1.5 GB one');
  assert.ok(shift('leger', 'C', 'A') >= 15, 'leger: the light one over the 80 GB one');
  assert.equal(standings(weightsOf('ratio')).best, 'D', 'the 900 seeders');
  assert.ok(shift('ratio', 'D', 'B') >= 15, 'ratio: the seeded one over the compact encode');
});

test('seeders only count when every torrent has them: ratio is then the same as equilibre', () => {
  assert.deepEqual(scoreGroup(lineup(false), weightsOf('ratio')), scoreGroup(lineup(false)));
  assert.notDeepEqual(scoreGroup(lineup(), weightsOf('ratio')).rows.map((r) => r.score), scoreGroup(lineup()).rows.map((r) => r.score));
  // Weights that only ask for what cannot be computed leave the default score.
  const onlyHealth = { lang: 0, quality: 0, health: 100, size: 0 };
  assert.deepEqual(scoreGroup(lineup(false), onlyHealth), scoreGroup(lineup(false)));
});

test('a weight at 0 ignores the criterion: no NaN, whole scores, and no line for it in the explanation', () => {
  const entries = lineup();
  for (const weights of [{ lang: 0, quality: 50, health: 25, size: 25 }, { lang: 0, quality: 0, health: 0, size: 100 }, { lang: 0, quality: 0, health: 100, size: 0 }]) {
    const group = scoreGroup(entries, weights);
    assert.ok(group.rows.every((row) => Number.isInteger(row.score) && row.score >= 0 && row.score <= 100), JSON.stringify(weights));
    const text = explain(entries[0], group.rows[0], group);
    assert.ok(!/NaN|Infinity/.test(text), text);
    if (weights.lang === 0) assert.ok(!text.includes('Langue'), text);
  }
});

test('the explanation names the profile only when the settings are not the default ones', () => {
  const entries = lineup();
  const group = scoreGroup(entries, weightsOf('leger'));
  assert.ok(!explain(entries[0], group.rows[0], group).includes('Profil'));
  group.profile = 'Petite taille';
  assert.ok(explain(entries[0], group.rows[0], group).endsWith('\nProfil : Petite taille'));
});

// ---------- the profile of the page ----------

function profileHarness(answer) {
  const calls = { sent: [], refreshed: 0, warned: 0 };
  const api = buildProfile(
    async (message) => { calls.sent.push(message); return answer(); },
    () => { calls.refreshed++; },
    cleanWeights, scoreGroup, WEIGHTS,
    { warn: () => { calls.warned++; } }
  );
  return { api, calls };
}
const LABELS = { qualite: 'Qualité d’image', vf: 'VF / MULTI d’abord', leger: 'Petite taille', ratio: 'Ratio (seeders)', perso: 'Personnalisé' };

test('the page keeps the default score whenever the settings cannot be read', async () => {
  const unusable = [
    () => { throw new Error('Extension context invalidated'); },
    () => ({ ok: false, error: 'Message inconnu' }),
    () => undefined,
    () => null,
    () => ({ ok: true }),
    () => ({ ok: true, score: 'vf' }),
    () => ({ ok: true, score: { preset: 'vf' } }),
    () => ({ ok: true, score: { preset: 'vf', weights: { lang: 70, quality: 15, health: 10 } } }),
    () => ({ ok: true, score: { preset: 'vf', weights: { lang: '70', quality: '15', health: '10', size: '5' } } }),
    () => ({ ok: true, score: { preset: 'vf', weights: { lang: 0, quality: 0, health: 0, size: 0 } } })
  ];
  for (const answer of unusable) {
    const { api, calls } = profileHarness(answer);
    api.start();
    await api.loadProfile();
    assert.deepEqual(calls.sent, [{ type: 'pagePrefs' }]);
    assert.deepEqual(api.current(), DEFAULT);
    assert.equal(calls.refreshed, 0);
    const group = api.scoreWithProfile(lineup());
    assert.deepEqual(group.rows, scoreGroup(lineup()).rows);
    assert.equal(group.profile, undefined);
  }
});

test('a usable answer sets the profile; the badges are scored again only once started, and only on a change', async () => {
  let answer = { ok: true, score: { preset: 'qualite', weights: weightsOf('qualite') } };
  const { api, calls } = profileHarness(() => answer);

  await api.loadProfile();
  assert.equal(api.current().preset, 'qualite');
  assert.equal(calls.refreshed, 0, 'nothing is scored yet');

  api.start();
  await api.loadProfile();
  assert.equal(calls.refreshed, 0, 'unchanged');

  answer = { ok: true, score: { preset: 'vf', weights: weightsOf('vf') } };
  await api.loadProfile();
  assert.deepEqual(api.current(), { preset: 'vf', weights: weightsOf('vf') });
  assert.equal(calls.refreshed, 1);

  answer = { ok: true, score: { preset: 'equilibre', weights: EQUILIBRE } };
  await api.loadProfile();
  assert.equal(calls.refreshed, 2);
  assert.equal(api.scoreWithProfile(lineup()).profile, undefined);

  // An id this page does not know is a custom profile; the weights are always clamped.
  answer = { ok: true, score: { preset: 'surprise', weights: { lang: 150, quality: -5, health: 10, size: 10 } } };
  await api.loadProfile();
  assert.deepEqual(api.current(), { preset: 'perso', weights: { lang: 100, quality: 0, health: 10, size: 10 } });
});

test('the badges show the pinned name of the profile, as the settings page does', async () => {
  const html = read('options.html');
  assert.ok(html.includes('<option value="equilibre">Équilibré (par défaut)</option>'));
  for (const [id, label] of Object.entries(LABELS)) {
    assert.ok(html.includes(`<option value="${id}">${label}</option>`), `options.html: ${id}`);
    const weights = id === 'perso' ? { lang: 10, quality: 20, health: 30, size: 40 } : weightsOf(id);
    const { api } = profileHarness(() => ({ ok: true, score: { preset: id, weights } }));
    await api.loadProfile();
    assert.equal(api.current().preset, id);
    assert.equal(api.scoreWithProfile(lineup()).profile, label, id);
  }
});

// ---------- the free space ----------

test('the categories come with the free space of the default path and of the paths of the categories', async () => {
  const free = { '/data/films': 5 * GIB, '/data/tv': 2 * GIB, '/data/dl': 900 * GIB };
  const e = engine({ route: fakeQb({ categories: CATEGORIES, free }) });
  const res = await e.ask({ type: 'getCategories', withSpace: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.categories, ['films', 'misc', 'tv']);
  assert.deepEqual(res.space, {
    defaultPath: '/data/dl',
    byPath: { '/data/films': 5 * GIB, '/data/tv': 2 * GIB, '/data/dl': 900 * GIB },
    categoryPaths: { films: '/data/films', misc: '/data/dl', tv: '/data/tv' }
  });
});

test('without withSpace the categories are what they were: one request, no space', async () => {
  for (const message of [{ type: 'getCategories' }, { type: 'getCategories', withSpace: false }]) {
    const e = engine({ route: fakeQb({ categories: CATEGORIES, free: { '/data/films': GIB } }) });
    const res = await e.ask(message);
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res).sort(), ['arrEnabled', 'byType', 'categories', 'defaultRoot', 'ok', 'selected']);
    assert.deepEqual(e.requests.map((r) => new URL(r.url).pathname), ['/api/v2/torrents/categories']);
  }
});

test('a qBittorrent without the endpoint shows no space, and is not asked again for 10 minutes', async () => {
  for (const status of [404, 400, 405]) {
    const e = engine({ route: fakeQb({ categories: CATEGORIES, spaceStatus: status }) });
    const first = await e.ask({ type: 'getCategories', withSpace: true });
    assert.equal(first.ok, true, String(status));
    assert.equal(first.space, null, String(status));
    assert.ok(spaceRequests(e).length > 0);
    const left = e.run('spaceUnsupported.until - Date.now()');
    assert.ok(left > 9 * 60 * 1000 && left <= 10 * 60 * 1000, `remembered for about 10 minutes (${left})`);

    const seen = e.requests.length;
    const second = await e.ask({ type: 'getCategories', withSpace: true });
    assert.equal(second.space, null);
    assert.deepEqual(e.requests.slice(seen).map((r) => new URL(r.url).pathname), ['/api/v2/torrents/categories'], 'not asked again');

    // Another qBittorrent address is another server.
    e.stores.local.qbUrl = 'http://other:8080';
    await e.ask({ type: 'getCategories', withSpace: true });
    assert.ok(e.requests.slice(seen).some((r) => r.url.startsWith('http://other:8080/api/v2/app/')), 'asked again at the new address');
    e.stores.local.qbUrl = 'http://qb:8080';

    e.run('spaceUnsupported.until = 0'); // the 10 minutes are over
    const asked = spaceRequests(e).length;
    await e.ask({ type: 'getCategories', withSpace: true });
    assert.ok(spaceRequests(e).length > asked, 'asked again');
  }
});

test('a failing lookup is not an unsupported endpoint: the categories are fine and nothing is remembered', async () => {
  const boom = () => { throw new Error('connection reset'); };
  for (const free of [{}, { '/data/films': boom, '/data/tv': boom, '/data/dl': boom }]) {
    const e = engine({ route: fakeQb({ categories: CATEGORIES, free }) });
    const res = await e.ask({ type: 'getCategories', withSpace: true });
    assert.equal(res.ok, true);
    assert.deepEqual(res.categories, ['films', 'misc', 'tv']);
    assert.equal(res.space, null);
    assert.equal(e.run('spaceUnsupported'), null);
    const asked = spaceRequests(e).length;
    await e.ask({ type: 'getCategories', withSpace: true });
    assert.ok(spaceRequests(e).length > asked, 'asked again');
  }
});

test('a lookup that never answers is cut at the timeout, and only costs its own path', async () => {
  const raw = { a: { savePath: '/data/a' }, b: { savePath: '/data/b' } };
  const cfg = { qbUrl: 'http://qb:8080' };
  const e = engine({ route: fakeQb({ categories: raw, free: { '/data/a': 3 * GIB, '/data/b': HANG, '/data/dl': 100 * GIB } }) });
  const started = Date.now();
  const space = plain(await e.run('freeSpace')(raw, cfg, 40));
  assert.ok(Date.now() - started < 1000, 'it did not wait for the answer that never comes');
  assert.deepEqual(space, { defaultPath: '/data/dl', byPath: { '/data/a': 3 * GIB, '/data/dl': 100 * GIB }, categoryPaths: { a: '/data/a' } });
  const slow = spaceRequests(e).find((r) => new URL(r.url).searchParams.get('path') === '/data/b');
  assert.equal(slow.opts.signal.aborted, true, 'the request is cancelled');

  const noDefault = engine({ route: fakeQb({ categories: raw, defaultPath: HANG, free: { '/data/a': 3 * GIB } }) });
  assert.deepEqual(plain(await noDefault.run('freeSpace')(raw, cfg, 40)),
    { defaultPath: '', byPath: { '/data/a': 3 * GIB }, categoryPaths: { a: '/data/a' } });
});

test('at most 10 distinct paths are looked up, all at once, the most useful categories first', async () => {
  const raw = { alias: { savePath: '/data/c0' }, empty: { savePath: '' }, none: null };
  for (let i = 0; i < 15; i++) raw[`c${String(i).padStart(2, '0')}`] = { savePath: `/data/c${i}` };

  // The gate opens when the 10th lookup arrives: a lookup after the other would wait for it in vain.
  let arrived = 0;
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const answer = () => { if (++arrived === 10) open(); return gate.then(() => reply(String(GIB))); };
  const free = { '/data/dl': answer };
  for (const info of Object.values(raw)) if (info && info.savePath) free[info.savePath] = answer;

  const e = engine({ route: fakeQb({ categories: raw, free }) });
  const space = plain(await e.run('freeSpace')(raw, { qbUrl: 'http://qb:8080', lastCategory: 'c14' }, 500));
  const expected = ['/data/c14', ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `/data/c${i}`), '/data/dl'];
  assert.deepEqual(askedPaths(e).sort(), expected.sort(), 'the category of the dialog first, no duplicate, no empty path');
  assert.deepEqual(Object.keys(space.byPath).sort(), expected.sort());
  assert.equal(space.categoryPaths.c14, '/data/c14');
  assert.equal(space.categoryPaths.alias, '/data/c0');
  assert.equal(space.categoryPaths.none, '/data/dl');
  assert.equal(space.categoryPaths.empty, '/data/dl');
});

test('what cannot be known is left out, and the paths are encoded in the request', async () => {
  const raw = {
    ok: { savePath: '/data/Films & Séries' },
    win: { savePath: 'D:\\Torrents' },
    err: { savePath: '/data/err' },
    negative: { savePath: '/data/negative' },
    junk: { savePath: '/data/junk' },
    relative: { savePath: 'relative/dir' },
    none: null
  };
  const free = { '/data/Films & Séries': 7 * GIB, 'D:\\Torrents': 9 * GIB, '/data/negative': '-1', '/data/junk': 'about 3 GB', '/data/dl': 50 * GIB };
  const e = engine({ route: fakeQb({ categories: raw, free }) }); // /data/err: the fake answers 500
  const res = await e.ask({ type: 'getCategories', withSpace: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.space, {
    defaultPath: '/data/dl',
    byPath: { '/data/Films & Séries': 7 * GIB, 'D:\\Torrents': 9 * GIB, '/data/dl': 50 * GIB },
    // A relative path is under the default one, and a category without one is in it.
    categoryPaths: { ok: '/data/Films & Séries', win: 'D:\\Torrents', relative: '/data/dl', none: '/data/dl' }
  });
  assert.ok(!askedPaths(e).includes('relative/dir'));
  assert.ok(spaceRequests(e).some((r) => r.url.endsWith('path=%2Fdata%2FFilms%20%26%20S%C3%A9ries')), 'the & cannot add a parameter');
});

// ---------- what the dialog says ----------

test('sizes are written in French, in binary units', () => {
  const cases = [[0, '0 o'], [500, '500 o'], [1023, '1023 o'], [1024, '1 Ko'], [1536, '1,5 Ko'], [10 * GIB, '10 Go'], [100 * GIB, '100 Go'],
    [99.96 * GIB, '100 Go'], [1.2 * 1024 * GIB, '1,2 To'], [1023.4 * GIB, '1023 Go'], [1023.7 * GIB, '1 To'], [3 * 1024 * 1024 * GIB, '3 Po'], [-5, '0 o']];
  for (const [bytes, text] of cases) assert.equal(formatBytes(bytes), text, String(bytes));
});

test('the disk note says what is free, and warns when the torrent would leave less than 1 Gio', () => {
  const space = { defaultPath: '/dl', byPath: { '/dl': 50 * GIB, '/films': 5 * GIB, '/full': 0, '/broken': -1 }, categoryPaths: { films: '/films', full: '/full', broken: '/broken' } };
  assert.deepEqual(spaceNote(space, '', 10), { info: 'Espace libre : 50 Go', warn: '' });
  assert.deepEqual(spaceNote(space, 'films', 3), { info: 'Espace libre : 5 Go', warn: '' });
  assert.equal(spaceNote(space, 'films', 4).warn, '', '4 Gio leave exactly 1 Gio');
  assert.equal(spaceNote(space, 'films', 4.01).warn, '⚠ Espace disque insuffisant : ce torrent fait 4 Go, il reste 5 Go.');
  assert.equal(spaceNote(space, 'films', 80).warn, '⚠ Espace disque insuffisant : ce torrent fait 80 Go, il reste 5 Go.');

  // Only what is known: no size, or no space.
  for (const size of [null, undefined, 0, NaN, Infinity, '3']) assert.deepEqual(spaceNote(space, 'films', size), { info: 'Espace libre : 5 Go', warn: '' }, String(size));
  const nothing = { info: '', warn: '' };
  for (const category of ['nope', 'constructor', '__proto__', 'toString', 'broken']) assert.deepEqual(spaceNote(space, category, 80), nothing, category);
  for (const unknown of [null, undefined, 'x', {}, { defaultPath: '/dl' }, { defaultPath: '/dl', byPath: null }, { categoryPaths: null, byPath: {} }]) {
    assert.deepEqual(spaceNote(unknown, 'films', 80), nothing);
    assert.deepEqual(spaceNote(unknown, '', 80), nothing);
  }
  assert.deepEqual(spaceNote(space, 'full', 0.5), { info: 'Espace libre : 0 o', warn: '⚠ Espace disque insuffisant : ce torrent fait 512 Mo, il reste 0 o.' });
});

// ---------- the update notice ----------

function updater({ stored, version = '1.8.1', answer = async () => ({ ok: true, json: async () => ({ version: '1.9.0' }) }) } = {}) {
  const nodes = {};
  const $ = (id) => (nodes[id] = nodes[id] || { hidden: true, textContent: '' });
  const store = stored === undefined ? {} : { updateCheck: stored };
  const fetched = [];
  const chrome = {
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: store[key] } : {}),
        set: async (patch) => { Object.assign(store, plain(patch)); }
      }
    },
    runtime: { getManifest: () => ({ version }) }
  };
  const api = buildUpdater($, chrome, async (url) => { fetched.push(url); return answer(); });
  return { ...api, store, fetched, banner: () => (nodes.update && !nodes.update.hidden ? nodes.updateText.textContent : null) };
}

test('versions are compared number by number', () => {
  const { isNewer } = updater();
  for (const [a, b] of [['1.10.0', '1.9.2'], ['1.8.2', '1.8.1'], ['2', '1.99.99'], ['1.8.0.1', '1.8'], ['10.0', '9.9']]) {
    assert.equal(isNewer(a, b), true, `${a} > ${b}`);
    assert.equal(isNewer(b, a), false, `${b} < ${a}`);
  }
  for (const [a, b] of [['1.8.1', '1.8.1'], ['1.8', '1.8.0'], ['1.8.0', '1.8']]) assert.equal(isNewer(a, b), false, `${a} = ${b}`);
  for (const junk of ['v1.9', '', undefined, null, '1.9-beta', '1..9', '1.9.', ' 1.9', '1.9\n', 'latest', {}]) {
    assert.equal(isNewer(junk, '1.8.1'), false, String(junk));
    assert.equal(isNewer('9.9.9', junk), false, String(junk));
  }
});

test('the popup says when a newer version is on GitHub, and asks at most every 12 hours', async () => {
  const now = Date.now();
  const hours = (n) => n * 60 * 60 * 1000;

  let u = updater();
  await u.checkUpdate();
  assert.deepEqual(u.fetched, ['https://raw.githubusercontent.com/HugoMeyer/arr411-chrome/main/manifest.json']);
  assert.equal(u.store.updateCheck.latest, '1.9.0');
  assert.ok(Math.abs(u.store.updateCheck.at - now) < 5000);
  assert.equal(u.banner(), 'Nouvelle version 1.9.0 disponible');

  u = updater({ stored: { at: now - hours(1), latest: '1.9.0' } });
  await u.checkUpdate();
  assert.deepEqual(u.fetched, [], 'the answer of the last hour is still good');
  assert.equal(u.banner(), 'Nouvelle version 1.9.0 disponible');

  u = updater({ stored: { at: now - hours(1), latest: '1.8.1' } });
  await u.checkUpdate();
  assert.deepEqual(u.fetched, []);
  assert.equal(u.banner(), null, 'nothing newer');

  for (const stored of [{ at: now - hours(13), latest: '1.0.0' }, { at: now + hours(1), latest: '1.0.0' }, 'x', { at: 'now', latest: 5 }, null]) {
    u = updater({ stored });
    await u.checkUpdate();
    assert.equal(u.fetched.length, 1, JSON.stringify(stored));
    assert.equal(u.store.updateCheck.latest, '1.9.0');
    assert.equal(u.banner(), 'Nouvelle version 1.9.0 disponible');
  }

  u = updater({ answer: async () => ({ ok: true, json: async () => ({ version: '1.8.1' }) }) });
  await u.checkUpdate();
  assert.equal(u.banner(), null, 'the same version is not news');
  assert.equal(u.store.updateCheck.latest, '1.8.1', 'it is cached all the same');
});

test('the update check is silent when anything goes wrong, and does not cache a failure', async () => {
  const failures = [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: false, json: async () => ({ version: '9.9.9' }) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    async () => ({ ok: true, json: async () => ({ version: 9 }) }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => null })
  ];
  for (const answer of failures) {
    const u = updater({ answer });
    await u.checkUpdate();
    assert.equal(u.banner(), null);
    assert.equal(u.store.updateCheck, undefined);
  }
});
