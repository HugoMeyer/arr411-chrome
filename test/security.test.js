'use strict';
// What the C411 page may ask of the engine (the page is not trusted), and what the engine may send to the servers it talks to,
// against fake qBittorrent / Radarr / Sonarr / Lidarr servers.
// Run with `node --test` (Node 18+, no dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const EXTENSION = 'chrome-extension://arr411/';
const PAGE = { tab: { id: 1 }, url: 'https://c411.org/torrents' };
const SHIM = { tab: { id: 0 } }; // what the shims of Android and Desktop give every message
const LOGIN = 'http://qb:8080/api/v2/auth/login';
const ARR = { radarrUrl: 'http://radarr:7878', radarrKey: 'K', radarrRoot: '/movies', radarrProfile: '4' };

const hashOf = (i) => i.toString(16).padStart(40, '0');
const latin1 = (s) => Buffer.from(s, 'latin1');
// What went through a vm boundary or a store is compared as plain data.
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

const reply = (body, status = 200, extra = {}) => ({
  ok: status < 400, status, type: 'basic',
  json: async () => plain(body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  ...extra
});
const opaqueRedirect = () => reply('', 0, { ok: false, type: 'opaqueredirect' });
const redirectedTo = (url) => reply([], 200, { url });

// `route({ url, u, method, headers, body, opts })` answers like the servers would.
function engine({ config = {}, route = () => reply([]), extensionUrl } = {}) {
  const requests = [];
  const tabs = [];
  const sent = [];
  const stores = { local: { qbUrl: 'http://qb:8080', username: 'u', password: 'p', notifyEnabled: false, ...config }, session: {} };

  const area = (data) => ({
    async get(keys) {
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out = { ...keys };
      for (const key of Object.keys(keys)) if (key in data) out[key] = data[key];
      return out;
    },
    async set(patch) { Object.assign(data, JSON.parse(JSON.stringify(patch))); }
  });

  const fetchMock = async (url, opts = {}) => {
    const request = { url: String(url), method: opts.method || 'GET', headers: plain(opts.headers) || {}, body: opts.body, opts };
    requests.push(request);
    return route({ ...request, u: new URL(url) });
  };

  const listener = () => ({ addListener(fn) { this.fn = fn; } });
  const chrome = {
    storage: { local: area(stores.local), session: area(stores.session) },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    tabs: { TAB_ID_NONE: -1, create: (options) => tabs.push(options.url), sendMessage: (tabId, message) => sent.push({ tabId, message: plain(message) }) },
    notifications: { create() {}, clear() {}, onClicked: listener() },
    alarms: { get: (name, done) => done({}), create() {}, onAlarm: listener() },
    downloads: { cancel: (id, done) => done && done(), erase() {}, onDeterminingFilename: listener() },
    runtime: { onInstalled: listener(), onStartup: listener(), onMessage: listener() }
  };
  if (extensionUrl) chrome.runtime.getURL = (p) => extensionUrl + p;

  const context = vm.createContext({ chrome, fetch: fetchMock, URL, URLSearchParams, console, atob, Blob, FormData, crypto: webcrypto });
  vm.runInContext(source, context);

  return {
    requests, tabs, sent, stores,
    run: (code) => vm.runInContext(code, context),
    ask: (message, sender = PAGE) => new Promise((resolve) => {
      chrome.runtime.onMessage.fn(message, sender, (response) => resolve(plain(response)));
    }),
    download: (item) => chrome.downloads.onDeterminingFilename.fn(item, () => {}),
    notificationClick: (id) => chrome.notifications.onClicked.fn(id)
  };
}

const refused = (res, pattern = /^Requête refusée/) => {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.error, pattern);
};

// A small bencoder to build torrents.
const enc = (v) => (typeof v === 'number' ? `i${v}e` : typeof v === 'string' ? `${v.length}:${v}`
  : Array.isArray(v) ? `l${v.map(enc).join('')}e` : `d${Object.keys(v).sort().map((k) => enc(k) + enc(v[k])).join('')}e`);
const INFO = { name: 'film.mkv', 'piece length': 16384, pieces: 'P'.repeat(20), files: [{ length: 5, path: ['a', 'b'] }] };
// The comment holds what looks like an info key: only the real one counts.
const TORRENT = latin1(enc({ announce: 'http://tracker/announce', comment: 'x4:infod3:fooi1eex', info: INFO, 'url-list': ['http://mirror/'] }));
const TORRENT_HASH = createHash('sha1').update(latin1(enc(INFO))).digest('hex');
const TORRENT_B64 = TORRENT.toString('base64');
const INVALID = 'Fichier .torrent invalide';

// ---------- hashes ----------

test('a hash from the page is a hash: it cannot add parameters to the qBittorrent request', async () => {
  const e = engine({ route: () => reply([{ name: 'Film', state: 'uploading', progress: 1, category: 'films' }]) });
  const hostile = ['&limit=1&offset=7', `${hashOf(1)}&limit=1`, `${hashOf(1)}|${hashOf(2)}`, 'all', hashOf(1).slice(1), `${hashOf(1)}0`, 7, [hashOf(1)], { toString: () => hashOf(1) }];
  for (const hash of hostile) refused(await e.ask({ type: 'pageStatus', hash }));
  assert.deepEqual(e.requests, [], 'nothing was asked of qBittorrent');

  const upper = 'AB'.repeat(20);
  const res = await e.ask({ type: 'pageStatus', hash: upper });
  assert.equal(res.ok, true);
  assert.equal(res.qbit.name, 'Film');
  assert.equal(new URL(e.requests[0].url).search, `?hashes=${upper.toLowerCase()}`);
  await e.ask({ type: 'pageStatus', hash: 'f'.repeat(64) });
  assert.equal(new URL(e.requests[1].url).search, `?hashes=${'f'.repeat(64)}`, 'a v2 hash is a hash too');
});

test('the list badges only look up real hashes, and no more than a page holds', async () => {
  const route = ({ u }) => {
    if (u.pathname.endsWith('/torrents/tags') || u.searchParams.has('hashes')) return reply([]);
    return reply(Array.from({ length: Number(u.searchParams.get('limit')) }, (_, i) => ({ hash: hashOf(i), name: `T${i}`, progress: 1, state: 'uploading', tags: '', added_on: i })));
  };
  const e = engine({ route, config: { listBadges: true } });
  const asked = () => e.requests.map((r) => new URL(r.url)).filter((u) => u.searchParams.has('hashes')).map((u) => u.searchParams.get('hashes'));

  const good = [hashOf(900), 'AB'.repeat(20)];
  const mixed = [...good, '&limit=1', 'all', 42, null, `${hashOf(901)}|${hashOf(902)}`];
  assert.deepEqual(plain(e.run('cleanPageMessage')({ type: 'qbitIndex', hashes: mixed }, PAGE).hashes), [hashOf(900), 'ab'.repeat(20)]);
  const res = await e.ask({ type: 'qbitIndex', hashes: mixed });
  assert.equal(res.ok, true);
  assert.deepEqual(asked(), [`${hashOf(900)}|${'ab'.repeat(20)}`]);

  const before = e.requests.length;
  refused(await e.ask({ type: 'qbitIndex', hashes: Array.from({ length: 301 }, (_, i) => hashOf(i)) }));
  refused(await e.ask({ type: 'qbitIndex', hashes: 'not-a-list' }));
  assert.equal(e.requests.length, before);
  assert.equal((await e.ask({ type: 'qbitIndex', hashes: Array.from({ length: 300 }, (_, i) => hashOf(i)) })).ok, true);
});

test('pausing and resuming only ever concerns one real torrent', async () => {
  const e = engine({ route: () => reply('') });
  for (const hash of ['all', `${hashOf(1)}|${hashOf(2)}`, '', undefined]) refused(await e.ask({ type: 'toggleTorrent', hash, pause: true }));
  refused(await e.ask({ type: 'toggleTorrent', hash: hashOf(1), pause: 'yes' }));
  assert.deepEqual(e.requests, []);

  assert.equal((await e.ask({ type: 'toggleTorrent', hash: hashOf(1), pause: true })).ok, true);
  assert.equal(new URL(e.requests[0].url).pathname, '/api/v2/torrents/stop');
  assert.equal(String(e.requests[0].body), `hashes=${hashOf(1)}`);
});

test('the hash of a lookup is encoded and checked again where the request is built', async () => {
  const e = engine();
  await assert.rejects(e.run('qbTorrentByHash')('&limit=1&offset=7'), /Requête refusée/);
  assert.deepEqual(e.requests, []);
});

// ---------- media ids ----------

test('media ids are numbers, tt… ids or UUIDs: nothing else reaches a Radarr/Sonarr/Lidarr URL', async () => {
  const route = ({ u }) => (u.pathname === '/api/v3/series'
    ? reply([{ tvdbId: 81189, title: 'S', seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 3, totalEpisodeCount: 10 } }], statistics: {} }])
    : reply([]));
  const e = engine({ config: { ...ARR, sonarrUrl: 'http://sonarr:8989', sonarrKey: 'K', lidarrUrl: 'http://lidarr:8686', lidarrKey: 'K' }, route });
  const hostile = [
    { tmdb: '603&apikey=x' }, { tmdb: '../../etc' }, { tmdb: -5 }, { tmdb: 1.5 }, { tmdb: '1e3' }, { tmdb: {} }, { tmdb: [603] },
    { imdb: 'tt1/../x' }, { imdb: '0133093' }, { tvdb: '8 1' }, { tvdb: 0 }, { tmdbKind: 'movie/../x' },
    { mbArtist: 'not-a-uuid' }, { mbReleaseGroup: '12345678-1234-1234-1234-123456789012/../x' }
  ];
  for (const ids of hostile) refused(await e.ask({ type: 'pageStatus', media: { type: 'movie', ids } }), /identifiant \w+ invalide/);
  refused(await e.ask({ type: 'pageStatus', media: { type: 'movie', ids: 'tt1' } }));
  refused(await e.ask({ type: 'pageStatus', media: { type: '../x', ids: {} } }));
  refused(await e.ask({ type: 'pageStatus', media: 'movie' }));
  assert.deepEqual(e.requests, [], 'no Arr request for a bad id');

  const movie = await e.ask({ type: 'pageStatus', media: { type: 'movie', ids: { tmdb: 603, tmdbKind: 'movie', imdb: 'tt0133093', unknown: '&x=1' } } });
  assert.equal(movie.ok, true);
  assert.deepEqual(e.requests.map((r) => r.url), ['http://radarr:7878/api/v3/movie?tmdbId=603']);
  assert.equal(e.requests[0].headers['X-Api-Key'], 'K');

  e.requests.length = 0;
  const series = await e.ask({ type: 'pageStatus', media: { type: 'series', ids: { tvdb: '81189' }, seasons: [1, 2, 'x', -1, 1000, 1.5] } });
  assert.deepEqual(series.library.seasons.map((s) => s.number), [1, 2], 'only real season numbers');
  assert.equal(e.requests[0].url, 'http://sonarr:8989/api/v3/series?tvdbId=81189');

  e.requests.length = 0;
  await e.ask({ type: 'pageStatus', media: { type: 'music', ids: { mbReleaseGroup: 'ABCDEF01-2345-6789-ABCD-EF0123456789' } } });
  assert.equal(e.requests[0].url, 'http://lidarr:8686/api/v1/album?foreignAlbumId=abcdef01-2345-6789-abcd-ef0123456789');
});

test('an id given to the lookups is encoded in the URL, whoever calls them', async () => {
  const e = engine({ config: { ...ARR, sonarrUrl: 'http://sonarr:8989', sonarrKey: 'K' } });
  const bad = '603&monitored=true';
  await e.run('findMovieInLibrary')(bad);
  await e.run('findSeriesInLibrary')(bad);
  await e.run('lookupMovie')({ tmdb: bad, imdb: 'tt1&x=1' });
  assert.deepEqual(e.requests.map((r) => r.url), [
    'http://radarr:7878/api/v3/movie?tmdbId=603%26monitored%3Dtrue',
    'http://sonarr:8989/api/v3/series?tvdbId=603%26monitored%3Dtrue',
    'http://radarr:7878/api/v3/movie/lookup/tmdb?tmdbId=603%26monitored%3Dtrue',
    'http://radarr:7878/api/v3/movie/lookup/imdb?imdbId=tt1%26x%3D1'
  ]);
});


// ---------- root folders ----------

test('a root folder chosen on the page counts only when Radarr or Sonarr lists it', async () => {
  const posts = [];
  const route = ({ u, method, body }) => {
    if (u.pathname.endsWith('/rootfolder')) return reply([{ path: u.pathname.includes('v3') && u.host === 'radarr:7878' ? '/movies' : '/tv' }, { path: '/uhd' }]);
    if (u.pathname === '/api/v3/movie/lookup/tmdb') return reply([{ tmdbId: 603, title: 'The Matrix' }]);
    if (u.pathname === '/api/v3/series/lookup') return reply([{ tvdbId: 81189, title: 'S', seasons: [] }]);
    if (method === 'POST') { posts.push({ path: u.pathname, ...JSON.parse(body) }); return reply({}); }
    return reply([]);
  };
  const e = engine({ config: { ...ARR, sonarrUrl: 'http://sonarr:8989', sonarrKey: 'K', sonarrRoot: '/tv', sonarrProfile: '2' }, route });
  const addToArr = e.run('addToArr');
  const movie = (rootFolder) => addToArr({ type: 'movie', ids: { tmdb: '603', tmdbKind: 'movie' }, rootFolder });

  for (const rootFolder of ['/uhd', '/etc/cron.d', '', '/movies', 'C:\\Windows']) await movie(rootFolder);
  assert.deepEqual(posts.map((p) => p.rootFolderPath), ['/uhd', '/movies', '/movies', '/movies', '/movies']);
  assert.equal(e.requests.filter((r) => r.url.endsWith('/rootfolder')).length, 3, 'only a root that differs from the configured one is looked up');

  posts.length = 0;
  for (const rootFolder of ['/uhd', '/var/lib']) await addToArr({ type: 'series', ids: { tvdb: '81189' }, rootFolder });
  assert.deepEqual(posts.map((p) => p.rootFolderPath), ['/uhd', '/tv']);
});

test('a root folder chosen on the page counts only when Lidarr lists it', async () => {
  const MB = '12345678-1234-1234-1234-123456789012';
  const posts = [];
  const route = ({ u, method, body }) => {
    const p = u.pathname.replace('/api/v1', '');
    if (p === '/rootfolder') return reply([{ path: '/music', defaultQualityProfileId: 1, defaultMetadataProfileId: 2 }, { path: '/lossless' }]);
    if (p === '/qualityprofile') return reply([{ id: 1, name: 'Any' }]);
    if (p === '/metadataprofile') return reply([{ id: 2, name: 'Standard' }]);
    if (p === '/artist/lookup') return reply([{ foreignArtistId: MB, artistName: 'Daft Punk' }]);
    if (p === '/artist' && method === 'POST') { posts.push(JSON.parse(body)); return reply({}); }
    return reply([]);
  };
  const e = engine({ config: { lidarrUrl: 'http://lidarr:8686', lidarrKey: 'K', lidarrRoot: '/music' }, route });
  const addToArr = e.run('addToArr');
  for (const rootFolder of ['/lossless', '/etc', '']) await addToArr({ type: 'music', lmode: 'artist', artist: 'Daft Punk', ids: { mbArtist: MB }, rootFolder });
  assert.deepEqual(posts.map((p) => p.rootFolderPath), ['/lossless', '/music', '/music']);
});

// ---------- what an upload and an arm may carry ----------

test('an upload carries a clean category, file name and pause flag, and 16 MB at most', async () => {
  const e = engine({ route: () => reply('Ok.') });
  const upload = (extra) => e.ask({ type: 'upload', base64: TORRENT_B64, filename: 'a.torrent', category: 'films', paused: false, ...extra });
  refused(await upload({ category: 'x'.repeat(256) }), /catégorie invalide/);
  refused(await upload({ category: 'a\r\nb' }), /catégorie invalide/);
  refused(await upload({ category: { toString: () => 'films' } }), /catégorie invalide/);
  refused(await upload({ paused: 'true' }), /pause invalide/);
  refused(await upload({ filename: 42 }), /nom de fichier invalide/);
  refused(await upload({ base64: '' }), /manquant/);
  refused(await upload({ base64: 'AAAA$AAA' }), /invalide/);
  refused(await upload({ base64: 'AAAAA' }), /invalide/);
  refused(await upload({ base64: 'A'.repeat(22369628) }), /volumineux/);
  refused(await upload({ media: { type: 'movie', rootFolder: 'x'.repeat(513) } }), /dossier racine invalide/);
  refused(await upload({ media: { type: 'movie', rootFolder: '/a\u0000b' } }), /dossier racine invalide/);
  assert.deepEqual(e.requests, []);

  const ok = await upload({ filename: '..\\..\\sub/evil\u0000.torrent', paused: true });
  assert.equal(ok.ok, true);
  const form = e.requests.find((r) => r.url.endsWith('/api/v2/torrents/add')).body;
  assert.equal(form.get('torrents').name, '....subevil.torrent');
  assert.equal(form.get('category'), 'films');
  assert.equal(form.get('paused'), 'true');
});

test('the size limit is exactly 16 MiB of decoded bytes', () => {
  const pageBase64 = engine().run('pageBase64');
  const atLimit = 'A'.repeat(22369622) + '==';
  assert.equal(pageBase64(atLimit), atLimit);
  assert.throws(() => pageBase64('A'.repeat(22369624)), /volumineux/, 'two bytes over, without padding');
  assert.throws(() => pageBase64('A'.repeat(22369624) + '=='), /volumineux/);
});

test('an upload as content.js sends it adds to Radarr first, then to qBittorrent, and tracks the torrent', async () => {
  const posts = [];
  const route = ({ u, method, body }) => {
    if (u.pathname === '/api/v2/torrents/add') return reply('Ok.');
    if (u.pathname === '/api/v3/movie/lookup/tmdb') return reply([{ tmdbId: 603, title: 'The Matrix' }]);
    if (u.pathname === '/api/v3/movie' && method === 'POST') { posts.push(JSON.parse(body)); return reply({}); }
    return reply([]);
  };
  const e = engine({ config: ARR, route });
  const media = { type: 'movie', ids: { tmdb: '603', imdb: 'tt0133093', tmdbKind: 'movie' }, rootFolder: '/movies', seriesType: undefined };
  const res = await e.ask({ type: 'upload', base64: TORRENT_B64, filename: 'The.Matrix.1999.torrent', category: 'films', paused: false, media });

  assert.equal(res.ok, true);
  assert.match(res.arrResult, /^ajouté à Radarr/);
  assert.equal(res.arrError, null);
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(e.stores.local.tracked), [TORRENT_HASH]);
  assert.equal(e.stores.local.lastCategory, 'films');
});

test('arm needs the tab of a page, and hands only clean data back to that tab', async () => {
  const e = engine();
  refused(await e.ask({ type: 'arm', category: 'films' }, {}), /onglet inconnu/);
  refused(await e.ask({ type: 'arm', category: 'films' }, { tab: { id: 'abc' } }), /onglet inconnu/);
  refused(await e.ask({ type: 'arm', category: 'x'.repeat(256) }), /catégorie invalide/);
  refused(await e.ask({ type: 'arm', category: 'a\nb' }), /catégorie invalide/);
  refused(await e.ask({ type: 'arm', category: 'films', paused: 'true' }), /pause invalide/);
  e.download({ id: 1, url: 'https://c411.org/a.torrent', filename: 'a.torrent' });
  assert.deepEqual(e.sent, [], 'a refused arm arms nothing');

  const media = { type: 'movie', ids: { tmdb: '603', evil: 'x' }, rootFolder: '/movies', extra: 1 };
  assert.equal((await e.ask({ type: 'arm', category: 'films', paused: true, media }, { tab: { id: 7 } })).ok, true);
  e.download({ id: 2, url: 'https://c411.org/a.torrent', filename: 'C:\\dl\\a.torrent' });
  assert.deepEqual(e.sent, [{
    tabId: 7,
    message: { type: 'fetchTorrent', url: 'https://c411.org/a.torrent', filename: 'a.torrent', category: 'films', paused: true, media: { type: 'movie', ids: { tmdb: '603' }, rootFolder: '/movies' } }
  }]);
});

test('only the pages of the extension may point arrMeta at another server', async () => {
  const cfg = { radarrUrl: 'http://other:7878', radarrKey: 'OTHER' };
  const e = engine({ extensionUrl: EXTENSION, config: { radarrUrl: 'http://radarr:7878', radarrKey: 'K' } });
  refused(await e.ask({ type: 'arrMeta', service: 'qbittorrent' }), /service invalide/);

  for (const sender of [PAGE, SHIM, { tab: { id: 1 }, url: `https://c411.org/${EXTENSION}` }]) {
    assert.equal((await e.ask({ type: 'arrMeta', service: 'radarr', cfg }, sender)).ok, true);
  }
  assert.ok(e.requests.length > 0);
  assert.ok(e.requests.every((r) => r.url.startsWith('http://radarr:7878/') && r.headers['X-Api-Key'] === 'K'), 'the page cannot choose the server or the key');

  e.requests.length = 0;
  await e.ask({ type: 'arrMeta', service: 'radarr', cfg }, { url: `${EXTENSION}options.html` });
  assert.ok(e.requests.length > 0);
  assert.ok(e.requests.every((r) => r.url.startsWith('http://other:7878/') && r.headers['X-Api-Key'] === 'OTHER'), 'the options page tests what it has just typed');
});

test('what is not a known request is refused, and the other requests still work', async () => {
  const e = engine({ config: ARR, route: ({ u }) => (u.pathname.endsWith('/torrents/categories') ? reply({ tv: {}, films: {} }) : reply([])) });
  for (const message of [null, 'upload', 42, { type: 'evil' }, {}, [], { type: ['upload'] }]) {
    const res = await e.ask(message);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Message inconnu');
  }
  const categories = await e.ask({ type: 'getCategories' });
  assert.deepEqual(categories.categories, ['films', 'tv']);
  assert.equal(categories.arrEnabled.movie, true);
  assert.equal((await e.ask({ type: 'disarm' })).ok, true);
});

// ---------- .torrent parsing ----------

test('the info hash is the SHA-1 of the info dictionary, wherever it sits among the keys', async () => {
  const infoHash = engine().run('infoHash');
  assert.equal(await infoHash(TORRENT), TORRENT_HASH);
  assert.equal(await infoHash(latin1(enc({ info: INFO }))), TORRENT_HASH);
  assert.equal(await infoHash(latin1(enc({ 'a-nested': { info: 1 }, info: INFO }))), TORRENT_HASH);
});

test('bencodeEnd reads whole elements and refuses what is cut short or absurd', () => {
  const bencodeEnd = engine().run('bencodeEnd');
  const end = (s, at = 0) => bencodeEnd(latin1(s), at);
  assert.equal(end('i42e'), 4);
  assert.equal(end('i-5e'), 4);
  assert.equal(end('0:'), 2);
  assert.equal(end('4:spam'), 6);
  assert.equal(end('l4:spami42ee'), 12);
  assert.equal(end('d3:cow3:moo4:spam4:eggse'), 24);
  assert.equal(end('xx4:spam', 2), 8);
  assert.equal(end('l'.repeat(10) + 'e'.repeat(10)), 20);

  for (const bad of ['', 'x', 'i12', 'ie', 'i-e', 'i1.5e', 'i1x2e', '5:ab', ':a', '99999999999:a', '4294967295:abc', 'l', 'li1e', 'd', 'd3:key', 'd3:keyi1e']) {
    assert.throws(() => end(bad), new RegExp(INVALID.replace('.', '\\.')), JSON.stringify(bad));
  }
  assert.throws(() => bencodeEnd(latin1('4:spam'), 6), /Fichier \.torrent invalide/, 'nothing at the offset');
});

test('a deeply nested or huge input is refused at once, without hanging or overflowing the stack', async () => {
  const { bencodeEnd, infoHash } = { bencodeEnd: engine().run('bencodeEnd'), infoHash: engine().run('infoHash') };
  const started = performance.now();
  assert.throws(() => bencodeEnd(latin1('l'.repeat(1_000_000)), 0), /Fichier \.torrent invalide/);
  assert.throws(() => bencodeEnd(latin1('d1:a'.repeat(250_000)), 0), /Fichier \.torrent invalide/);
  for (const deep of [`d4:info${'l'.repeat(500_000)}`, `d4:info${'d1:a'.repeat(250_000)}`, `d4:info${'l'.repeat(5000)}${'e'.repeat(5000)}`]) {
    await assert.rejects(infoHash(latin1(deep)), /Fichier \.torrent invalide/);
  }
  assert.ok(performance.now() - started < 2000, 'bounded work');
});

test('a truncated or damaged .torrent is never anything but "Fichier .torrent invalide"', { timeout: 60000 }, async () => {
  const infoHash = engine().run('infoHash');
  const hashOrNull = async (bytes) => {
    try { return await infoHash(bytes); } catch (err) {
      assert.equal(err.message, INVALID);
      return null;
    }
  };
  for (let n = 0; n < TORRENT.length; n++) {
    const hash = await hashOrNull(TORRENT.subarray(0, n));
    assert.ok(hash === null || hash === TORRENT_HASH, `prefix of ${n} bytes`);
  }
  let s = 0x9e3779b9;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 1000; i++) {
    const copy = Buffer.from(TORRENT);
    for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
    const hash = await hashOrNull(copy);
    assert.ok(hash === null || /^[0-9a-f]{40}$/.test(hash));
  }
});

test('a malformed .torrent is refused before anything is sent to qBittorrent', async () => {
  const e = engine({ route: () => reply('Ok.') });
  const asList = `l${enc('info')}${enc(INFO)}e`; // the right bytes, but a list instead of a dictionary
  for (const bad of ['not a torrent', 'd4:info', 'd4:infod4:name', `d4:info${'l'.repeat(100000)}`, 'd4:infoi12', 'd3:fooi1ee', asList, enc('info') + enc(INFO)]) {
    const res = await e.ask({ type: 'upload', base64: latin1(bad).toString('base64'), filename: 'x.torrent', category: '', paused: false });
    assert.deepEqual([res.ok, res.error], [false, INVALID], bad.slice(0, 20));
  }
  assert.deepEqual(e.requests, []);
});

// ---------- redirects ----------

test('without a redirect a request is a single one, and the browser is never left to follow one', async () => {
  const e = engine({ route: () => reply('', 204) });
  const secretFetch = e.run('secretFetch');
  assert.equal((await secretFetch(LOGIN, { method: 'POST', body: new URLSearchParams({ password: 'x' }) })).status, 204);
  assert.equal(e.requests.length, 1);
  assert.equal(e.requests[0].opts.redirect, 'manual');

  // The shims never answer with a redirect, nor with a url: the same single request.
  const shim = engine({ route: () => ({ ok: true, status: 204, text: async () => '', json: async () => ({}) }) });
  assert.equal((await shim.run('secretFetch')(LOGIN, { method: 'POST' })).status, 204);
  assert.equal(shim.requests.length, 1);
});

test('a redirect to the same server (http to https included) is followed with the same request, after a probe that carries no secret', async () => {
  const final = 'https://qb:8443/api/v2/auth/login';
  const route = ({ url, opts }) => {
    if (url !== LOGIN) return reply('', 204);
    return opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo(final);
  };
  const e = engine({ route });
  const res = await e.run('secretFetch')(LOGIN, { method: 'POST', credentials: 'include', body: new URLSearchParams({ username: 'u', password: 'hunter2' }) });

  assert.equal(res.status, 204);
  assert.deepEqual(e.requests.map((r) => `${r.method} ${r.url} ${r.opts.redirect}`), [`POST ${LOGIN} manual`, `GET ${LOGIN} follow`, `POST ${final} manual`]);
  const [first, probe, last] = e.requests;
  assert.equal(String(first.body), 'username=u&password=hunter2');
  assert.equal(probe.body, undefined);
  assert.equal(probe.opts.headers, undefined);
  assert.equal(probe.opts.credentials, 'omit');
  assert.equal(String(last.body), String(first.body));
});

test('a redirect to another server is refused: the secrets only ever went to the configured one', async () => {
  const elsewhere = ['http://evil.example/steal', 'https://evil.example/', 'http://qb.evil.example:8080/', 'http://127.0.0.1:8080/', 'http://qb:9090/api/v2/auth/login', 'javascript:alert(1)'];
  for (const to of elsewhere) {
    const e = engine({ route: ({ opts }) => (opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo(to)) });
    const body = new URLSearchParams({ username: 'u', password: 'hunter2' });
    await assert.rejects(e.run('secretFetch')(LOGIN, { method: 'POST', body }), /Redirection vers un autre serveur refusée/, to);
    assert.equal(e.requests.length, 2, 'the request and the probe, nothing else');
    assert.ok(e.requests.every((r) => new URL(r.url).host === 'qb:8080'), to);
    assert.equal(e.requests.filter((r) => r.body).length, 1, 'the body went out once');
  }

  const downgrade = engine({ route: ({ opts }) => (opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo('http://qb/api')) });
  await assert.rejects(downgrade.run('secretFetch')('https://qb/api', {}), /Redirection vers un autre serveur refusée \(qb\)/);

  const named = engine({ route: ({ opts }) => (opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo('http://evil.example/x')) });
  await assert.rejects(named.run('secretFetch')(LOGIN, {}), /\(evil\.example\) : mets l’adresse finale dans les réglages/);
});

test('the qBittorrent password and the Arr API keys are not sent to what a server redirects to', async () => {
  const route = ({ u, opts }) => {
    if (u.pathname === '/api/v2/torrents/categories') return reply('', 403);
    return opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo('http://evil.example/x');
  };
  const qb = engine({ route });
  refused(await qb.ask({ type: 'getCategories' }), /Redirection vers un autre serveur refusée \(evil\.example\)/);
  assert.equal(qb.requests.filter((r) => String(r.body).includes('password=')).length, 1);
  assert.ok(qb.requests.every((r) => new URL(r.url).host === 'qb:8080'));

  const arr = engine({ config: { radarrUrl: 'http://radarr:7878', radarrKey: 'SECRET-KEY' }, route });
  refused(await arr.ask({ type: 'arrMeta', service: 'radarr' }), /Redirection vers un autre serveur refusée \(evil\.example\)/);
  assert.ok(arr.requests.every((r) => new URL(r.url).host === 'radarr:7878'));
  const withKey = arr.requests.filter((r) => JSON.stringify(r.headers).includes('SECRET-KEY'));
  assert.ok(withKey.length > 0 && withKey.every((r) => r.opts.redirect === 'manual'), 'the key only travels in requests that cannot follow a redirect');
  assert.ok(arr.requests.filter((r) => r.opts.redirect === 'follow').every((r) => !r.opts.headers && !r.opts.body && r.opts.credentials === 'omit'));
});

test('the .torrent uploaded to qBittorrent is not sent to what a redirect leads to either', async () => {
  const route = ({ u, opts }) => {
    if (u.pathname !== '/api/v2/torrents/add') return reply('Ok.');
    return opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo('https://evil.example/collect');
  };
  const e = engine({ route });
  refused(await e.ask({ type: 'upload', base64: TORRENT_B64, filename: 'x.torrent', category: 'films', paused: false }), /Redirection vers un autre serveur refusée \(evil\.example\)/);
  assert.ok(e.requests.every((r) => new URL(r.url).host === 'qb:8080'));
  assert.equal(e.requests.filter((r) => r.body).length, 1, 'the file went out once, to the configured server');
  assert.deepEqual(e.requests.map((r) => r.opts.redirect), ['manual', 'follow']);
});

test('a redirect that cannot be checked, or that never ends, is an error', async () => {
  const unknown = engine({ route: ({ opts }) => (opts.redirect === 'manual' ? opaqueRedirect() : reply([])) });
  await assert.rejects(unknown.run('secretFetch')(LOGIN, {}), /Redirection non vérifiable/);

  const unreachable = engine({ route: ({ opts }) => { if (opts.redirect === 'manual') return opaqueRedirect(); throw new TypeError('Failed to fetch'); } });
  await assert.rejects(unreachable.run('secretFetch')(LOGIN, {}), /Redirection non vérifiable : mets l’adresse finale dans les réglages/);
  assert.equal(unreachable.requests.length, 2, 'nothing was sent anywhere after the probe failed');

  let hops = 0;
  const endless = engine({ route: ({ opts }) => (opts.redirect === 'manual' ? opaqueRedirect() : redirectedTo(`http://qb:8080/hop${++hops}`)) });
  await assert.rejects(endless.run('secretFetch')(LOGIN, {}), /Trop de redirections/);
  assert.equal(endless.requests.length, 12, 'five redirects followed, then given up');
});

test('only the same host counts as the same server, an http to https upgrade being the one change of scheme', () => {
  const sameServer = engine().run('sameServer');
  const same = [
    ['http://qb:8080/a', 'http://qb:8080/b'], ['http://qb:8080/a', 'https://qb:8443/a'], ['http://qb:8080/a', 'https://qb:8080/a'],
    ['https://qb/a', 'https://QB/b'], ['http://qb/a', 'http://qb:80/a']
  ];
  const other = [
    ['https://qb/a', 'http://qb/a'], ['http://qb:8080/a', 'http://qb:9090/a'], ['http://qb:8080/a', 'http://evil:8080/a'],
    ['http://qb:8080/a', 'http://qb.evil.com:8080/a'], ['http://qb:8080/a', 'javascript:alert(1)'], ['http://qb:8080/a', 'not a url'], ['not a url', 'http://qb:8080/a']
  ];
  for (const [from, to] of same) assert.equal(sameServer(from, to), true, `${from} -> ${to}`);
  for (const [from, to] of other) assert.equal(sameServer(from, to), false, `${from} -> ${to}`);
});

// ---------- URLs opened in a tab ----------

test('only web pages and magnet links are ever opened in a tab', async () => {
  const safeUrl = engine().run('safeUrl');
  for (const url of ['https://qb.example/', 'http://192.168.1.10:8080', `magnet:?xt=urn:btih:${'a'.repeat(40)}`]) assert.ok(safeUrl(url), url);
  const hostile = [
    'javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/Windows/win.ini', 'chrome://settings',
    'chrome-extension://x/a.html', 'ftp://x/', 'blob:https://x/y', 'qb:8080', '', undefined, null, 42, {}
  ];
  for (const url of hostile) assert.equal(safeUrl(url), null, String(url));

  const opened = engine();
  opened.run('openUrl')('javascript:alert(1)');
  opened.run('openUrl')('https://qb.example/');
  assert.deepEqual(opened.tabs, ['https://qb.example/']);
});

test('clicking a notification opens the qBittorrent address only when it is a web address', async () => {
  const hostile = engine({ config: { qbUrl: 'javascript:alert(1)' } });
  await hostile.notificationClick('done:x');
  assert.deepEqual(hostile.tabs, []);

  const normal = engine({ config: { qbUrl: 'http://qb:8080/' } });
  await normal.notificationClick('done:x');
  assert.deepEqual(normal.tabs, ['http://qb:8080/']);
});
