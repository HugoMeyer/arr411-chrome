const DEFAULTS = {
  qbUrl: '', username: '', password: '', defaultCategory: '', lastCategory: '',
  radarrUrl: '', radarrKey: '', radarrRoot: '', radarrProfile: '', radarrCategory: '',
  sonarrUrl: '', sonarrKey: '', sonarrRoot: '', sonarrProfile: '', sonarrCategory: '',
  lidarrUrl: '', lidarrKey: '', lidarrRoot: '', lidarrProfile: '', lidarrMetaProfile: '', lidarrCategory: 'lidarr',
  notifyEnabled: true, notifyAll: false, listBadges: true,
  scorePreset: 'equilibre', scoreWeights: { lang: 30, quality: 30, health: 20, size: 20 }
};
const ARM_TIMEOUT_MS = 20000;
let pending = null; // { tabId, category, paused, media, expires }

async function getConfig() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  cfg.qbUrl = (cfg.qbUrl || DEFAULTS.qbUrl).replace(/\/+$/, '');
  return cfg;
}

// ---------- Redirects and URLs ----------

// A request that carries a secret (qBittorrent password, the .torrent uploaded with its tracker passkey, Radarr/Sonarr/Lidarr
// API key) must never follow a redirect to another server: a 307/308 would send it the same body and headers. Redirects are
// followed by hand, within the same host only.
const MAX_REDIRECTS = 5;
const REDIRECT_HINT = 'mets l’adresse finale dans les réglages';

// An http → https upgrade of the same host is fine, and may change the port.
function sameServer(from, to) {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.hostname !== b.hostname) return false;
    if (a.protocol === b.protocol) return a.port === b.port;
    return a.protocol === 'http:' && b.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url).slice(0, 80); }
}

async function secretFetch(url, opts = {}) {
  let target = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(target, { ...opts, redirect: 'manual' });
    // Only a browser answers a redirect with an opaque response; the shims of the apps never do (their native layer refuses
    // cross-host redirects itself), so the usual path is a single request.
    if (!res || res.type !== 'opaqueredirect') return res;
    // The Location of an opaque redirect is hidden: a request without any secret finds where it leads.
    const probe = await fetch(target, { method: 'GET', credentials: 'omit', redirect: 'follow' }).catch(() => null);
    const next = probe && probe.url;
    if (!next || next === target) throw new Error(`Redirection non vérifiable : ${REDIRECT_HINT}`);
    if (!sameServer(target, next)) throw new Error(`Redirection vers un autre serveur refusée (${hostOf(next)}) : ${REDIRECT_HINT}`);
    target = next;
  }
  throw new Error(`Trop de redirections : ${REDIRECT_HINT}`);
}

// Only web pages and magnet links are ever opened in a tab.
function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return ['https:', 'http:', 'magnet:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function openUrl(value) {
  const url = safeUrl(value);
  if (url) chrome.tabs.create({ url });
}

// ---------- qBittorrent ----------

// qBittorrent rejects requests whose Origin/Referer don't match its host (CSRF protection).
async function ensureHeaderRule(base) {
  if (!base) throw new Error('URL qBittorrent non configurée : ouvre les options de l’extension.');
  const origin = new URL(base).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: origin },
          { header: 'Referer', operation: 'set', value: origin + '/' }
        ]
      },
      condition: {
        requestDomains: [new URL(base).hostname],
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest', 'other']
      }
    }]
  });
}

async function login(cfg) {
  const res = await secretFetch(cfg.qbUrl + '/api/v2/auth/login', {
    method: 'POST',
    credentials: 'include',
    body: new URLSearchParams({ username: cfg.username, password: cfg.password })
  });
  const text = (await res.text()).trim();
  // Recent qBittorrent answers 204 with an empty body; older versions answer 200 "Ok.".
  if (res.status !== 204 && !(res.ok && /^ok/i.test(text))) throw new Error(`Connexion qBittorrent refusée (${res.status} ${text})`);
}

async function qbFetch(path, opts = {}, retry = true) {
  const cfg = await getConfig();
  await ensureHeaderRule(cfg.qbUrl);
  const res = await secretFetch(cfg.qbUrl + path, { credentials: 'include', ...opts });
  if ((res.status === 401 || res.status === 403) && retry) {
    await login(cfg);
    return qbFetch(path, opts, false);
  }
  return res;
}

async function readCategories() {
  const res = await qbFetch('/api/v2/torrents/categories');
  if (!res.ok) throw new Error(`Impossible de lire les catégories (${res.status})`);
  return res.json();
}

const categoryNames = (raw) => Object.keys(raw).sort((a, b) => a.localeCompare(b));

// ---------- Free disk space ----------

// qBittorrent ≥ 5.3 (Web API 2.15.2) tells the free space of a path; older versions answer 404 (or 400/405). The send dialog only
// wants a hint: a failure leaves that path out, and sync/maindata (far too heavy with thousands of torrents) is never used.
const SPACE_TIMEOUT_MS = 1500;
const SPACE_MAX_PATHS = 10;
const SPACE_RETRY_MS = 10 * 60 * 1000;
const NO_SPACE_API = [400, 404, 405];
let spaceUnsupported = null; // { url, until }: this server has no such endpoint, it is not asked again for a while

const noSpaceApi = (url) => !!spaceUnsupported && spaceUnsupported.url === url && spaceUnsupported.until > Date.now();
const spaceText = async (res) => (res.ok ? (await res.text()).trim() : '');
// A relative category path is relative to the default save path: it has no free space of its own to look up.
const absolutePath = (p) => (typeof p === 'string' && /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p) ? p : '');

// { defaultPath, byPath: { path: bytes }, categoryPaths: { category: path } } for the default save path and the save paths of the
// categories (the one the dialog opens on first), or null when nothing is known. Never throws, and answers within timeoutMs.
async function freeSpace(raw, cfg, timeoutMs = SPACE_TIMEOUT_MS) {
  if (noSpaceApi(cfg.qbUrl)) return null;
  const abort = new AbortController();
  const opts = { signal: abort.signal };
  let timer;
  // The shims of the apps ignore the abort signal: the race is what bounds the wait.
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(); }, timeoutMs); });

  const known = new Map(); // path → free bytes
  const asked = new Set();
  const lookup = (path) => {
    if (asked.has(path)) return Promise.resolve();
    asked.add(path);
    return qbFetch(`/api/v2/app/getFreeSpaceAtPath?path=${encodeURIComponent(path)}`, opts).then(async (res) => {
      if (NO_SPACE_API.includes(res.status)) { spaceUnsupported = { url: cfg.qbUrl, until: Date.now() + SPACE_RETRY_MS }; return; }
      const text = await spaceText(res);
      if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) known.set(path, Number(text)); // -1 means qBittorrent could not tell
    }).catch(() => {});
  };

  const own = (name) => {
    const info = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : null;
    return info ? absolutePath(info.savePath) : '';
  };
  // The most useful categories first, the default path always has its slot.
  const wanted = [cfg.lastCategory || cfg.defaultCategory, cfg.radarrCategory, cfg.sonarrCategory, cfg.lidarrCategory, ...categoryNames(raw)];
  const paths = [...new Set(wanted.map(own).filter(Boolean))].slice(0, SPACE_MAX_PATHS - 1);

  let defaultPath = '';
  const jobs = paths.map(lookup);
  jobs.push(qbFetch('/api/v2/app/defaultSavePath', opts).then(spaceText).then((text) => {
    defaultPath = absolutePath(text);
    return defaultPath && lookup(defaultPath);
  }).catch(() => {}));
  await Promise.race([Promise.all(jobs), deadline]);
  clearTimeout(timer);

  if (noSpaceApi(cfg.qbUrl) || !known.size) return null;
  const categoryPaths = Object.fromEntries(Object.keys(raw).map((name) => [name, own(name) || defaultPath]).filter(([, path]) => known.has(path)));
  return { defaultPath, byPath: Object.fromEntries(known), categoryPaths };
}

async function addTorrent({ base64, filename, category, paused }) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  // A malformed file is refused before anything is sent. Other failures (no crypto in the page) only cost the completion notification.
  const hash = await infoHash(bytes).catch((e) => { if (e.message === TORRENT_INVALID) throw e; return null; });
  const buildForm = () => {
    const form = new FormData();
    form.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), filename || 'file.torrent');
    if (category) form.append('category', category);
    if (paused) { form.append('paused', 'true'); form.append('stopped', 'true'); }
    return form;
  };
  let res = await qbFetch('/api/v2/torrents/add', { method: 'POST', body: buildForm() }, false);
  if (res.status === 401 || res.status === 403) {
    await login(await getConfig());
    res = await qbFetch('/api/v2/torrents/add', { method: 'POST', body: buildForm() }, false);
  }
  const text = (await res.text()).trim();
  if (!res.ok || text === 'Fails.') throw new Error(`qBittorrent a refusé le torrent (${res.status} ${text})`);
  await chrome.storage.local.set({ lastCategory: category || '' });
  indexCache = null; // the list badges must see the torrent that was just added
  if (hash) await trackTorrent(hash, filename);
  return hash;
}

const TORRENT_INVALID = 'Fichier .torrent invalide';
const BENCODE_MAX_DEPTH = 64;
const BENCODE_MAX_DIGITS = 10;
const INFO_KEY = [0x69, 0x6e, 0x66, 0x6f]; // "info"

// [start, end) of the content of the bencoded string at i ("4:spam"); its length must fit in what is left of the file.
function bencodeStr(b, i) {
  let k = i;
  let len = 0;
  while (k < b.length && b[k] >= 0x30 && b[k] <= 0x39) {
    if (k - i >= BENCODE_MAX_DIGITS) throw new Error(TORRENT_INVALID);
    len = len * 10 + (b[k] - 0x30);
    k++;
  }
  if (k === i || b[k] !== 0x3a || len > b.length - k - 1) throw new Error(TORRENT_INVALID);
  return [k + 1, k + 1 + len];
}

// Returns the index just past the bencoded element starting at i. Truncated, malformed or too deeply nested input throws.
function bencodeEnd(b, i, depth = 0) {
  if (depth > BENCODE_MAX_DEPTH || i >= b.length) throw new Error(TORRENT_INVALID);
  const c = b[i];
  if (c === 0x69) { // i...e
    let k = i + 1;
    if (b[k] === 0x2d) k++;
    const digits = k;
    while (k < b.length && b[k] >= 0x30 && b[k] <= 0x39) k++;
    if (k === digits || b[k] !== 0x65) throw new Error(TORRENT_INVALID);
    return k + 1;
  }
  if (c === 0x6c || c === 0x64) { // l...e / d...e
    let k = i + 1;
    while (k < b.length && b[k] !== 0x65) k = bencodeEnd(b, k, depth + 1);
    if (k >= b.length) throw new Error(TORRENT_INVALID);
    return k + 1;
  }
  return bencodeStr(b, i)[1];
}

// [start, end) of the bencoded "info" dictionary of a .torrent.
function torrentInfoSpan(bytes) {
  if (bytes[0] !== 0x64) throw new Error(TORRENT_INVALID);
  let i = 1;
  while (i < bytes.length && bytes[i] !== 0x65) {
    const [keyStart, keyEnd] = bencodeStr(bytes, i);
    const valEnd = bencodeEnd(bytes, keyEnd);
    if (keyEnd - keyStart === INFO_KEY.length && INFO_KEY.every((c, n) => bytes[keyStart + n] === c)) return [keyEnd, valEnd];
    i = valEnd;
  }
  throw new Error(TORRENT_INVALID);
}

// v1 infohash = SHA-1 of the raw bencoded "info" dictionary.
async function infoHash(bytes) {
  const [start, end] = torrentInfoSpan(bytes);
  const digest = await crypto.subtle.digest('SHA-1', bytes.slice(start, end));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- Large libraries ----------

// A ratio farm can hold tens of thousands of torrents: listing them all is tens of MB per request, many times an hour.
// What runs in the background therefore asks qBittorrent only for what it needs.
const QUIET_TAGS = ['zen-farm']; // never notified, and left out of the lists that cannot be fetched whole
const HASH_CHUNK = 40;           // hashes per request: keeps the URL short
const LIST_LIMIT = 500;          // torrents asked per request when listing
const POPUP_DONE = 20;           // completed torrents shown by the popup
const INDEX_TTL_MS = 30000;      // how long the list badges reuse a listing
const NOTIFY_MAX = 3;            // completions shown one by one per poll; the rest is summed up in one notification

const isQuietTag = (tag) => QUIET_TAGS.includes(String(tag).trim().toLowerCase());
const isQuiet = (t) => (t.tags || '').split(',').some(isQuietTag);

async function qbJson(path) {
  const res = await qbFetch(path);
  if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
  return res.json();
}

async function torrentsByHash(hashes) {
  const found = [];
  for (let i = 0; i < hashes.length; i += HASH_CHUNK) {
    found.push(...await qbJson('/api/v2/torrents/info?hashes=' + hashes.slice(i, i + HASH_CHUNK).join('|')));
  }
  return found;
}

// `query` (a filter and a sort), asked tag by tag with the quiet tags left out: what a farm hides at the top of a plain listing is found
// this way. `tag=` alone means "without tag".
async function listByTag(query, limit) {
  const tags = (await qbJson('/api/v2/torrents/tags')).filter((tag) => !isQuietTag(tag));
  const byHash = new Map();
  for (const tag of ['', ...tags]) {
    for (const t of await qbJson(`/api/v2/torrents/info?tag=${encodeURIComponent(tag)}&${query}&limit=${limit}`)) {
      if (!isQuiet(t)) byHash.set(t.hash, t);
    }
  }
  return [...byHash.values()];
}

// The newest torrents of the library, most recent first. `complete` tells that the library fits in `limit` and nothing is missing;
// otherwise it is listed through its tags, the quiet ones left out.
async function listLibrary(limit = LIST_LIMIT) {
  const query = 'sort=added_on&reverse=true';
  const first = await qbJson(`/api/v2/torrents/info?${query}&limit=${limit}`);
  if (first.length < limit) return { torrents: first, complete: true };
  return { torrents: (await listByTag(query, limit)).sort((a, b) => b.added_on - a.added_on), complete: false };
}

// The latest completions, most recent first, the quiet ones left out. A farm completes in bulk, so the newest ones can all be quiet:
// the tags are asked one by one in that case only.
async function latestCompleted(count) {
  const query = 'filter=completed&sort=completion_on&reverse=true';
  const probe = count * 3;
  const first = await qbJson(`/api/v2/torrents/info?${query}&limit=${probe}`);
  const kept = first.filter((t) => !isQuiet(t));
  const found = kept.length >= count || first.length < probe ? kept : await listByTag(query, count);
  return found.sort((a, b) => b.completion_on - a.completion_on).slice(0, count);
}

// ---------- Completion notifications ----------

async function trackTorrent(hash, name) {
  const { tracked = {} } = await chrome.storage.local.get('tracked');
  tracked[hash] = { name: (name || '').replace(/\.torrent$/i, ''), added: Date.now() };
  await chrome.storage.local.set({ tracked });
}

async function pollCompletions() {
  const cfg = await getConfig();
  if (!cfg.notifyEnabled) return;
  const { tracked = {} } = await chrome.storage.local.get('tracked');
  const { incomplete = [] } = await chrome.storage.session.get('incomplete');
  const hashes = Object.keys(tracked);
  if (!cfg.notifyAll && !hashes.length) return;

  // Never the whole library (ratio farms hold tens of thousands of torrents): the torrents still downloading are listed, then the ones
  // that left that list since the last poll are looked up by hash.
  const downloading = cfg.notifyAll ? (await qbJson('/api/v2/torrents/info?filter=downloading')).map((t) => t.hash) : [];
  const inProgress = new Set(downloading);
  const left = incomplete.filter((h) => !inProgress.has(h));
  const list = await torrentsByHash([...new Set([...hashes, ...left])]);
  const seen = new Set(list.map((t) => t.hash));
  let shown = 0;
  let more = 0;

  for (const t of list) {
    if (t.progress < 1) continue;
    const wasWatched = tracked[t.hash] || (cfg.notifyAll && incomplete.includes(t.hash));
    if (!wasWatched) continue;
    if (isQuiet(t)) { delete tracked[t.hash]; continue; }
    if (shown >= NOTIFY_MAX) { more++; delete tracked[t.hash]; continue; }
    shown++;
    chrome.notifications.create('done:' + t.hash, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Téléchargement terminé',
      message: t.name,
      contextMessage: t.category ? `Catégorie : ${t.category}` : 'qBittorrent'
    });
    delete tracked[t.hash];
  }
  if (more) {
    chrome.notifications.create('done:more', {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Téléchargements terminés',
      message: `+ ${more} autre${more > 1 ? 's' : ''} téléchargement${more > 1 ? 's' : ''} terminé${more > 1 ? 's' : ''}`,
      contextMessage: 'qBittorrent'
    });
  }
  // Forget tracked torrents removed from qBittorrent.
  for (const h of hashes) {
    if (tracked[h] && !seen.has(h) && Date.now() - tracked[h].added > 10 * 60000) delete tracked[h];
  }
  await chrome.storage.local.set({ tracked });
  if (cfg.notifyAll) await chrome.storage.session.set({ incomplete: downloading });
  else if (incomplete.length) await chrome.storage.session.set({ incomplete: [] });
}

function ensureAlarm() {
  chrome.alarms.get('poll', (a) => { if (!a) chrome.alarms.create('poll', { periodInMinutes: 0.5 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') pollCompletions().catch(() => {}); });
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const cfg = await getConfig();
  openUrl(cfg.qbUrl);
});

// ---------- Popup / list badges ----------

// What the popup shows: everything in progress (paused and queued included), and the latest completions.
async function listTorrents() {
  const [active, completed, iRes] = await Promise.all([
    qbJson('/api/v2/torrents/info?filter=downloading&sort=added_on&reverse=true'),
    latestCompleted(POPUP_DONE),
    qbFetch('/api/v2/transfer/info')
  ]);
  const torrents = [...active.filter((t) => !isQuiet(t)), ...completed].map((t) => ({
    hash: t.hash, name: t.name, state: t.state, progress: t.progress, dlspeed: t.dlspeed, upspeed: t.upspeed,
    eta: t.eta, size: t.size, category: t.category, ratio: t.ratio, completion_on: t.completion_on, added_on: t.added_on
  }));
  const info = iRes.ok ? await iRes.json() : {};
  return { torrents, dlspeed: info.dl_info_speed || 0, upspeed: info.up_info_speed || 0 };
}

// What the list badges of a C411 page are matched against: the library (shared by the pages for a moment), plus the torrents of the page
// that a partial listing left out, found by hash.
let indexCache = null; // { at, torrents: Map, complete }

async function badgeIndex(wanted) {
  if (!indexCache || Date.now() - indexCache.at > INDEX_TTL_MS) {
    const { torrents, complete } = await listLibrary();
    indexCache = { at: Date.now(), torrents: new Map(torrents.map((t) => [t.hash, t])), complete };
  }
  const index = new Map(indexCache.torrents);
  if (!indexCache.complete) {
    const missing = (wanted || []).filter((h) => /^[a-f0-9]{40}$/.test(h) && !index.has(h)).slice(0, 300);
    for (const t of await torrentsByHash(missing)) index.set(t.hash, t);
  }
  return [...index.values()].map(({ hash, name, progress, state }) => ({ hash, name, progress, state }));
}

// qBittorrent 5 renamed pause/resume to stop/start.
async function toggleTorrent(hash, pause) {
  const body = () => new URLSearchParams({ hashes: hash });
  let res = await qbFetch(`/api/v2/torrents/${pause ? 'stop' : 'start'}`, { method: 'POST', body: body() });
  if (res.status === 404) res = await qbFetch(`/api/v2/torrents/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: body() });
  if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
}

// ---------- Radarr / Sonarr / Lidarr ----------

const ARR_LABEL = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };

function arrErrorMessage(data) {
  if (Array.isArray(data)) return data.map((e) => e.errorMessage || e.message || JSON.stringify(e)).join(' ; ');
  if (data && typeof data === 'object') return data.message || data.error || JSON.stringify(data);
  return String(data).slice(0, 200);
}

async function arr(service, path, opts = {}, cfgOverride) {
  const cfg = cfgOverride || await getConfig();
  const base = (cfg[service + 'Url'] || '').trim().replace(/\/+$/, '');
  const key = (cfg[service + 'Key'] || '').trim();
  if (!base || !key) throw new Error(`${ARR_LABEL[service]} n’est pas configuré`);
  const res = await secretFetch(base + (service === 'lidarr' ? '/api/v1' : '/api/v3') + path, {
    ...opts,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${ARR_LABEL[service]} ${res.status} : ${arrErrorMessage(data)}`);
  return data;
}

async function arrMeta(service, cfg) {
  const [profiles, roots, metaProfiles] = await Promise.all([
    arr(service, '/qualityprofile', {}, cfg),
    arr(service, '/rootfolder', {}, cfg),
    service === 'lidarr' ? arr(service, '/metadataprofile', {}, cfg) : null
  ]);
  const out = {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    roots: roots.map((r) => r.path)
  };
  if (metaProfiles) out.metaProfiles = metaProfiles.map((p) => ({ id: p.id, name: p.name }));
  return out;
}

const first = (x) => (Array.isArray(x) ? x[0] : x);
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);

async function lookupMovie(ids) {
  let movie = null;
  if (ids.tmdb && ids.tmdbKind !== 'tv') movie = first(await arr('radarr', `/movie/lookup/tmdb?tmdbId=${encodeURIComponent(ids.tmdb)}`).catch(() => null));
  if (!movie && ids.imdb) movie = first(await arr('radarr', `/movie/lookup/imdb?imdbId=${encodeURIComponent(ids.imdb)}`).catch(() => null));
  return movie && movie.tmdbId ? movie : null;
}

async function findMovieInLibrary(tmdbId) {
  const list = asList(await arr('radarr', `/movie?tmdbId=${encodeURIComponent(tmdbId)}`));
  return list.find((m) => String(m.tmdbId) === String(tmdbId)) || null;
}

async function lookupSeries(ids) {
  const terms = [];
  if (ids.tvdb) terms.push(`tvdb:${ids.tvdb}`);
  if (ids.imdb) terms.push(`imdb:${ids.imdb}`);
  if (ids.tmdb && ids.tmdbKind === 'tv') terms.push(`tmdb:${ids.tmdb}`);
  for (const term of terms) {
    const results = await arr('sonarr', `/series/lookup?term=${encodeURIComponent(term)}`).catch(() => []);
    if (Array.isArray(results) && results.length) {
      const s = (ids.tvdb && results.find((r) => String(r.tvdbId) === String(ids.tvdb))) || results[0];
      if (s && s.tvdbId) return s;
    }
  }
  return null;
}

async function findSeriesInLibrary(tvdbId) {
  const list = asList(await arr('sonarr', `/series?tvdbId=${encodeURIComponent(tvdbId)}`));
  return list.find((s) => String(s.tvdbId) === String(tvdbId)) || null;
}

// The root folder of an addition: the one chosen on the page only when the service really has it, the configured one otherwise.
async function pickRoot(service, chosen, configured) {
  if (!chosen || chosen === configured) return configured;
  const roots = asList(await arr(service, '/rootfolder'));
  return roots.some((r) => r.path === chosen) ? chosen : configured;
}

// Entries are always added unmonitored: downloads come from C411, never from Radarr/Sonarr.
async function addMovie(ids, cfg, rootFolder) {
  rootFolder = await pickRoot('radarr', rootFolder, cfg.radarrRoot);
  if (!rootFolder || !cfg.radarrProfile) throw new Error('Radarr : dossier racine / profil qualité non configurés');
  const movie = await lookupMovie(ids);
  if (!movie) throw new Error('Radarr : film introuvable');

  if (movie.id || await findMovieInLibrary(movie.tmdbId)) return `déjà dans Radarr (${movie.title})`;
  await arr('radarr', '/movie', {
    method: 'POST',
    body: JSON.stringify({
      ...movie,
      qualityProfileId: Number(cfg.radarrProfile),
      rootFolderPath: rootFolder,
      monitored: false,
      minimumAvailability: movie.minimumAvailability || 'released',
      addOptions: { monitor: 'none', searchForMovie: false }
    })
  });
  return `ajouté à Radarr, non surveillé (${movie.title})`;
}

async function addSeries(ids, cfg, rootFolder, seriesType) {
  rootFolder = await pickRoot('sonarr', rootFolder, cfg.sonarrRoot);
  if (!rootFolder || !cfg.sonarrProfile) throw new Error('Sonarr : dossier racine / profil qualité non configurés');
  const series = await lookupSeries(ids);
  if (!series) throw new Error('Sonarr : série introuvable');

  const existing = await findSeriesInLibrary(series.tvdbId);
  if (existing) return `déjà dans Sonarr (${existing.title})`;

  await arr('sonarr', '/series', {
    method: 'POST',
    body: JSON.stringify({
      ...series,
      qualityProfileId: Number(cfg.sonarrProfile),
      languageProfileId: 1,
      rootFolderPath: rootFolder,
      seriesType: seriesType || series.seriesType || 'standard',
      monitored: false,
      seasonFolder: true,
      seasons: (series.seasons || []).map((s) => ({ ...s, monitored: false })),
      addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false }
    })
  });
  return `ajouté à Sonarr, non surveillée (${series.title})`;
}

// ---------- Lidarr (music) ----------

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mbCache = new Map();
const normTitle = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const sameTitle = (a, b) => {
  a = normTitle(a);
  b = normTitle(b);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};
const mbArtistOf = (x) => ((((x && x['artist-credit']) || [])[0] || {}).artist || {}).id;
const quote = (s) => '"' + String(s).replace(/["\\]/g, ' ') + '"';
// A lookup may fail for one unknown ID (Lidarr metadata server): try the next way, but never hide
// a bad API key, a missing configuration or an unreachable server.
const softFail = (fallback) => (e) => {
  if (e instanceof TypeError || /^Lidarr (401|403) |n’est pas configuré/.test(e.message)) throw e;
  return fallback;
};

// Public MusicBrainz API (CORS enabled); answers are kept while the service worker lives.
function mbGet(path) {
  if (!mbCache.has(path)) {
    mbCache.set(path, fetch(`https://musicbrainz.org/ws/2/${path}${path.includes('?') ? '&' : '?'}fmt=json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`MusicBrainz ${r.status}`))))
      .catch((e) => { mbCache.delete(path); throw e; }));
  }
  return mbCache.get(path);
}

// C411 links MusicBrainz releases; Lidarr works with release groups. Without IDs: MusicBrainz search.
async function musicIds(media) {
  const ids = { ...(media.ids || {}) };
  if (MBID.test(ids.mbRelease || '') && !ids.mbReleaseGroup) {
    const r = await mbGet(`release/${ids.mbRelease}?inc=release-groups+artist-credits`).catch(() => null);
    if (r && r['release-group']) {
      ids.mbReleaseGroup = r['release-group'].id;
      ids.mbArtist = ids.mbArtist || mbArtistOf(r);
    }
  }
  if (!ids.mbReleaseGroup && media.album && media.lmode !== 'artist') {
    const q = 'releasegroup:' + quote(media.album) + (media.artist ? ' AND artist:' + quote(media.artist) : '');
    const r = await mbGet(`release-group?limit=10&query=${encodeURIComponent(q)}`).catch(() => null);
    const rg = r && (r['release-groups'] || []).find((g) => g.score >= 80 && normTitle(g.title) === normTitle(media.album));
    if (rg) {
      ids.mbReleaseGroup = rg.id;
      ids.mbArtist = ids.mbArtist || mbArtistOf(rg);
    }
  }
  return ids;
}

async function lidarrFindArtist(mbArtist, name) {
  if (MBID.test(mbArtist || '')) {
    const a = asList(await arr('lidarr', `/artist?mbId=${encodeURIComponent(mbArtist)}`)).find((x) => x.foreignArtistId === mbArtist);
    if (a || !name) return a || null;
  }
  if (!name) return null;
  return asList(await arr('lidarr', '/artist')).find((x) => normTitle(x.artistName) === normTitle(name)) || null;
}

async function lidarrLookupArtist(media, ids) {
  if (MBID.test(ids.mbArtist || '')) {
    const a = first(await arr('lidarr', `/artist/lookup?term=${encodeURIComponent('lidarr:' + ids.mbArtist)}`).catch(softFail(null)));
    if (a && a.foreignArtistId) return a;
  }
  if (!media.artist) return null;
  const list = asList(await arr('lidarr', `/artist/lookup?term=${encodeURIComponent(media.artist)}`).catch(softFail([])));
  return list.find((a) => normTitle(a.artistName) === normTitle(media.artist)) || null;
}

async function lidarrLookupAlbum(media, ids) {
  for (const id of [ids.mbReleaseGroup, ids.mbRelease]) {
    if (!MBID.test(id || '')) continue;
    const a = first(await arr('lidarr', `/album/lookup?term=${encodeURIComponent('lidarr:' + id)}`).catch(softFail(null)));
    if (a && a.foreignAlbumId) return a;
  }
  if (!media.album) return null;
  const artistOk = (x) => !media.artist || (x.artist && ((ids.mbArtist && x.artist.foreignArtistId === ids.mbArtist) ||
    sameTitle(x.artist.artistName, media.artist)));
  for (const term of [[media.artist, media.album].filter(Boolean).join(' '), media.album]) {
    const list = asList(await arr('lidarr', `/album/lookup?term=${encodeURIComponent(term)}`).catch(softFail([])));
    const a = list.find((x) => sameTitle(x.title, media.album) && artistOk(x));
    if (a) return a;
  }
  return null;
}

// Root folder + profiles: options first, then the root folder defaults. "None" = only manually added albums.
// A root folder chosen on the page counts only when Lidarr lists it.
async function lidarrTarget(cfg, rootFolder, forArtist) {
  const [roots, qps, mps] = (await Promise.all(['/rootfolder', '/qualityprofile', '/metadataprofile']
    .map((p) => arr('lidarr', p, {}, cfg)))).map(asList);
  const chosen = rootFolder && roots.some((r) => r.path === rootFolder) ? rootFolder : '';
  const path = chosen || cfg.lidarrRoot || (roots[0] && roots[0].path);
  if (!path) throw new Error('Lidarr : aucun dossier racine');
  const rf = roots.find((r) => r.path === path) || {};
  const pick = (list, ids, ok = () => true) => ids.map(Number).find((id) => list.some((p) => p.id === id && ok(p)));
  const quality = pick(qps, [cfg.lidarrProfile, rf.defaultQualityProfileId, qps[0] && qps[0].id]);
  const realMeta = mps.find((p) => p.name !== 'None');
  const metadata = pick(mps, [cfg.lidarrMetaProfile, rf.defaultMetadataProfileId, realMeta && realMeta.id],
    (p) => !forArtist || p.name !== 'None');
  if (!quality || !metadata) throw new Error('Lidarr : profil qualité / métadonnées introuvable');
  return { path, quality, metadata };
}

// Artists and albums are always added unmonitored, without any search.
const lidarrArtistBody = (artist, t) => ({
  ...artist,
  qualityProfileId: t.quality,
  metadataProfileId: t.metadata,
  rootFolderPath: t.path,
  monitored: false,
  monitorNewItems: 'none',
  albumFolder: true,
  tags: [],
  addOptions: { monitor: 'none', searchForMissingAlbums: false }
});

async function addMusic(media, cfg) {
  const ids = await musicIds(media);
  if (media.lmode === 'artist') {
    let artist = await lidarrFindArtist(ids.mbArtist, media.artist);
    if (!artist) artist = await lidarrLookupArtist(media, ids);
    if (!artist) throw new Error('Lidarr : artiste introuvable');
    if (artist.id) return `déjà dans Lidarr (${artist.artistName})`;
    const t = await lidarrTarget(cfg, media.rootFolder, true);
    await arr('lidarr', '/artist', { method: 'POST', body: JSON.stringify(lidarrArtistBody(artist, t)) });
    return `artiste ajouté à Lidarr, non surveillé (${artist.artistName})`;
  }
  const album = await lidarrLookupAlbum(media, ids);
  if (!album) throw new Error('Lidarr : album introuvable (corrige artiste / album, ou choisis « L’artiste seul »)');
  const name = album.title + (album.artist && album.artist.artistName ? ` — ${album.artist.artistName}` : '');
  if (album.id) return `déjà dans Lidarr (${name})`;
  const inLib = asList(await arr('lidarr', `/album?foreignAlbumId=${encodeURIComponent(album.foreignAlbumId)}`))
    .find((x) => x.foreignAlbumId === album.foreignAlbumId);
  if (inLib) return `déjà dans Lidarr (${name})`;
  let artist = album.artist || {};
  if (!artist.id) {
    artist = (await lidarrFindArtist(artist.foreignArtistId)) ||
      lidarrArtistBody(artist, await lidarrTarget(cfg, media.rootFolder, false));
  }
  await arr('lidarr', '/album', {
    method: 'POST',
    body: JSON.stringify({ ...album, artist, monitored: false, anyReleaseOk: true, addOptions: { searchForNewAlbum: false } })
  });
  return `ajouté à Lidarr, non surveillé (${name})`;
}

async function addToArr(media) {
  if (!media || !media.type) return null;
  const cfg = await getConfig();
  if (media.type === 'music') return addMusic(media, cfg);
  return media.type === 'movie'
    ? addMovie(media.ids, cfg, media.rootFolder)
    : addSeries(media.ids, cfg, media.rootFolder, media.seriesType);
}

// ---------- Page status (duplicates / library) ----------

async function qbTorrentByHash(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('Requête refusée : hash invalide');
  const res = await qbFetch(`/api/v2/torrents/info?hashes=${encodeURIComponent(hash.toLowerCase())}`);
  if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
  const t = first(await res.json());
  return t ? { name: t.name, state: t.state, progress: t.progress, category: t.category } : null;
}

async function movieStatus(ids) {
  let movie = null;
  if (ids.tmdb && ids.tmdbKind === 'movie') movie = await findMovieInLibrary(ids.tmdb);
  else {
    const found = await lookupMovie(ids);
    if (found) movie = found.id ? found : await findMovieInLibrary(found.tmdbId);
  }
  if (!movie) return { service: 'Radarr', inLibrary: false };
  return { service: 'Radarr', inLibrary: true, title: movie.title, hasFile: !!movie.hasFile, monitored: !!movie.monitored };
}

async function seriesStatus(ids, seasons) {
  let tvdbId = ids.tvdb;
  if (!tvdbId) {
    const found = await lookupSeries(ids);
    tvdbId = found && found.tvdbId;
  }
  const series = tvdbId ? await findSeriesInLibrary(tvdbId) : null;
  if (!series) return { service: 'Sonarr', inLibrary: false };
  const seasonInfo = seasons.map((n) => {
    const s = (series.seasons || []).find((x) => x.seasonNumber === n);
    const st = (s && s.statistics) || {};
    return { number: n, exists: !!s, monitored: !!(s && s.monitored), files: st.episodeFileCount || 0, total: st.totalEpisodeCount || st.episodeCount || 0 };
  });
  const st = series.statistics || {};
  return {
    service: 'Sonarr', inLibrary: true, title: series.title, seasons: seasonInfo,
    files: st.episodeFileCount || 0, total: st.episodeCount || st.totalEpisodeCount || 0
  };
}

async function musicStatus(media) {
  const ids = await musicIds(media);
  let album = null;
  let artist = null;
  if (ids.mbReleaseGroup) {
    album = asList(await arr('lidarr', `/album?foreignAlbumId=${encodeURIComponent(ids.mbReleaseGroup)}`))
      .find((x) => x.foreignAlbumId === ids.mbReleaseGroup) || null;
  }
  if (!album) {
    artist = await lidarrFindArtist(ids.mbArtist, media.artist);
    if (artist && media.album) {
      album = asList(await arr('lidarr', `/album?artistId=${encodeURIComponent(artist.id)}`))
        .find((x) => normTitle(x.title) === normTitle(media.album)) || null;
    }
  }
  if (!album) return artist ? { service: 'Lidarr', inLibrary: true, artistOnly: true, title: artist.artistName } : { service: 'Lidarr', inLibrary: false };
  const st = album.statistics || {};
  return { service: 'Lidarr', inLibrary: true, title: album.title, files: st.trackFileCount || 0, total: st.totalTrackCount || 0 };
}

async function pageStatus({ hash, media }) {
  const cfg = await getConfig();
  const [qbit, library] = await Promise.all([
    hash ? qbTorrentByHash(hash).catch(() => undefined) : undefined,
    (async () => {
      if (!media || !media.type) return undefined;
      if (media.type === 'movie' && cfg.radarrUrl && cfg.radarrKey) return movieStatus(media.ids);
      if (media.type === 'series' && cfg.sonarrUrl && cfg.sonarrKey) return seriesStatus(media.ids, media.seasons || []);
      if (media.type === 'music' && cfg.lidarrUrl && cfg.lidarrKey) return musicStatus(media);
      return undefined;
    })().catch(() => undefined)
  ]);
  return { qbit, library };
}

// ---------- Download interception ----------

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!pending || Date.now() > pending.expires) {
    pending = null;
    suggest();
    return;
  }
  const job = pending;
  pending = null;
  chrome.downloads.cancel(item.id, () => {
    chrome.downloads.erase({ id: item.id });
  });
  suggest();
  chrome.tabs.sendMessage(job.tabId, {
    type: 'fetchTorrent',
    url: item.finalUrl || item.url,
    filename: (item.filename || '').split(/[\\/]/).pop() || 'file.torrent',
    category: job.category,
    paused: job.paused,
    media: job.media
  });
});

// ---------- Score presets ----------

// Weights of the parts of the torrent score that content.js computes (each preset adds up to 100). equilibre is the historical
// score. qualite: a Remux/BDMV 2160p beats the compact encodes. vf: MULTI.VFF/VOF well ahead of VF2/VFQ/VOSTFR. leger: the size
// part rewards the quality kept per GB. ratio: seeders first; a torrent page only knows its own seeders, so health is left out
// there and ratio scores like equilibre. perso: the weights saved in the settings.
const SCORE_KEYS = ['lang', 'quality', 'health', 'size'];
const SCORE_PRESETS = {
  equilibre: { lang: 30, quality: 30, health: 20, size: 20 },
  qualite: { lang: 20, quality: 65, health: 10, size: 5 },
  vf: { lang: 70, quality: 15, health: 10, size: 5 },
  leger: { lang: 20, quality: 10, health: 10, size: 60 },
  ratio: { lang: 15, quality: 15, health: 60, size: 10 }
};

function scoreWeight(v, fallback) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
}

// { preset, weights } the page scores with. What is unknown or unusable (unknown preset, perso weights all at 0) is equilibre.
function scorePrefs(cfg) {
  const id = cfg && typeof cfg.scorePreset === 'string' ? cfg.scorePreset : '';
  if (Object.prototype.hasOwnProperty.call(SCORE_PRESETS, id)) return { preset: id, weights: { ...SCORE_PRESETS[id] } };
  if (id === 'perso') {
    const saved = isObject(cfg.scoreWeights) ? cfg.scoreWeights : {};
    const weights = Object.fromEntries(SCORE_KEYS.map((k) => [k, scoreWeight(saved[k], SCORE_PRESETS.equilibre[k])]));
    if (SCORE_KEYS.some((k) => weights[k] > 0)) return { preset: 'perso', weights };
  }
  return { preset: 'equilibre', weights: { ...SCORE_PRESETS.equilibre } };
}

// ---------- Messages from the page ----------

// The C411 page is not trusted: what it asks of the engine is rebuilt here from validated fields only, never passed through as is.
// The engine is shared by the 3 apps, and the shims of Android/Desktop give every sender the same identity: the checks apply to all.
const MAX_TORRENT_BYTES = 16 * 1024 * 1024; // same limit as the native layers
const TOO_BIG = 'fichier .torrent trop volumineux (16 Mo maximum)';
const MAX_INDEX_HASHES = 300;               // what a page asks at most in one qbitIndex
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const IMDB_ID = /^tt\d{1,10}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SERVICES = ['radarr', 'sonarr', 'lidarr'];
const MEDIA_TYPES = ['movie', 'series', 'music'];
const SERIES_TYPES = ['standard', 'anime', 'daily'];
const MUSIC_MODES = ['album', 'artist'];

const refuse = (what) => new Error(`Requête refusée : ${what}`);
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isBlank = (x) => x === undefined || x === null || x === '';

const pageHash = (v) => {
  if (typeof v !== 'string' || !HASH.test(v)) throw refuse('hash invalide');
  return v.toLowerCase();
};

const pageFlag = (v, what) => {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw refuse(`${what} invalide`);
  return v;
};

const pageText = (v, max, what) => {
  if (isBlank(v)) return '';
  if (typeof v !== 'string' || v.length > max || CONTROL.test(v)) throw refuse(`${what} invalide`);
  return v;
};

const pageEnum = (v, list, what) => {
  if (!list.includes(v)) throw refuse(`${what} invalide`);
  return v;
};

// Free text read from the page (artist, album): cleaned up rather than refused.
const pageLabel = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 200) : '');

function pageFilename(v) {
  if (isBlank(v)) return 'file.torrent';
  if (typeof v !== 'string') throw refuse('nom de fichier invalide');
  return v.replace(/[\u0000-\u001f\u007f\\/]/g, '').trim().slice(0, 255) || 'file.torrent';
}

function pageBase64(v) {
  if (typeof v !== 'string' || !v) throw refuse('fichier .torrent manquant');
  if (v.length > Math.ceil(MAX_TORRENT_BYTES / 3) * 4) throw refuse(TOO_BIG);
  if (v.length % 4 === 1 || !BASE64.test(v)) throw refuse('fichier .torrent invalide');
  const padding = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0;
  if (Math.floor(v.length * 3 / 4) - padding > MAX_TORRENT_BYTES) throw refuse(TOO_BIG);
  return v;
}

function numericId(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= 9999999999 ? String(n) : null;
}
const imdbId = (v) => (typeof v === 'string' && IMDB_ID.test(v) ? v : null);
const mbId = (v) => (typeof v === 'string' && MBID.test(v) ? v.toLowerCase() : null);
const tmdbKind = (v) => (v === 'movie' || v === 'tv' ? v : null);
const ID_RULES = {
  tmdb: numericId, tvdb: numericId, deezer: numericId, discogs: numericId,
  imdb: imdbId, mbRelease: mbId, mbReleaseGroup: mbId, mbArtist: mbId, tmdbKind
};

function cleanIds(ids) {
  if (isBlank(ids)) return {};
  if (!isObject(ids)) throw refuse('identifiants invalides');
  const out = {};
  for (const [key, rule] of Object.entries(ID_RULES)) {
    if (isBlank(ids[key])) continue;
    const value = rule(ids[key]);
    if (value === null) throw refuse(`identifiant ${key} invalide`);
    out[key] = value;
  }
  return out;
}

function cleanSeasons(v) {
  if (isBlank(v)) return [];
  if (!Array.isArray(v)) throw refuse('saisons invalides');
  return v.slice(0, 200).filter((n) => Number.isInteger(n) && n >= 0 && n <= 99).slice(0, 100);
}

function cleanMedia(m) {
  if (isBlank(m)) return null;
  if (!isObject(m)) throw refuse('média invalide');
  if (isBlank(m.type)) return null;
  const media = {
    type: pageEnum(m.type, MEDIA_TYPES, 'type de média'),
    ids: cleanIds(m.ids),
    rootFolder: pageText(m.rootFolder, 512, 'dossier racine')
  };
  if (media.type === 'series') {
    media.seasons = cleanSeasons(m.seasons);
    media.seriesType = isBlank(m.seriesType) ? '' : pageEnum(m.seriesType, SERIES_TYPES, 'type de série');
  }
  if (media.type === 'music') {
    media.artist = pageLabel(m.artist);
    media.album = pageLabel(m.album);
    media.year = typeof m.year === 'string' && /^\d{4}$/.test(m.year) ? m.year : '';
    media.lmode = isBlank(m.lmode) ? 'album' : pageEnum(m.lmode, MUSIC_MODES, 'mode Lidarr');
  }
  return media;
}

// The pages of the extension (options, popup) are told apart from the C411 page by their URL. The shims of the apps give none:
// everything they relay is treated as coming from the page.
function isExtensionPage(sender) {
  const base = chrome.runtime && typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : '';
  return !!base && !!sender && typeof sender.url === 'string' && sender.url.startsWith(base);
}

function cleanPageMessage(msg, sender) {
  switch (msg.type) {
    case 'pageStatus':
      return { type: msg.type, hash: isBlank(msg.hash) ? '' : pageHash(msg.hash), media: cleanMedia(msg.media) };
    case 'qbitIndex': {
      if (isBlank(msg.hashes)) return { type: msg.type, hashes: [] };
      if (!Array.isArray(msg.hashes) || msg.hashes.length > MAX_INDEX_HASHES) throw refuse('liste de hash invalide');
      return { type: msg.type, hashes: msg.hashes.filter((h) => typeof h === 'string' && HASH.test(h)).map((h) => h.toLowerCase()) };
    }
    case 'toggleTorrent':
      if (typeof msg.pause !== 'boolean') throw refuse('pause invalide');
      return { type: msg.type, hash: pageHash(msg.hash), pause: msg.pause };
    case 'arm':
      if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) throw refuse('onglet inconnu');
      return {
        type: msg.type, category: pageText(msg.category, 255, 'catégorie'), paused: pageFlag(msg.paused, 'pause'), media: cleanMedia(msg.media)
      };
    case 'upload':
      return {
        type: msg.type, base64: pageBase64(msg.base64), filename: pageFilename(msg.filename),
        category: pageText(msg.category, 255, 'catégorie'), paused: pageFlag(msg.paused, 'pause'), media: cleanMedia(msg.media)
      };
    case 'arrMeta': {
      const out = { type: msg.type, service: pageEnum(msg.service, SERVICES, 'service') };
      if (isExtensionPage(sender) && isObject(msg.cfg)) out.cfg = msg.cfg;
      return out;
    }
    case 'pagePrefs':
      return { type: msg.type };
    case 'getCategories':
      return { type: msg.type, withSpace: pageFlag(msg.withSpace, 'espace disque') };
    default:
      return msg;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object') throw new Error('Message inconnu');
    msg = cleanPageMessage(msg, sender);
    switch (msg.type) {
      case 'getCategories': {
        const cfg = await getConfig();
        const raw = await readCategories();
        const out = {
          categories: categoryNames(raw),
          selected: cfg.lastCategory || cfg.defaultCategory,
          byType: { movie: cfg.radarrCategory, series: cfg.sonarrCategory, music: cfg.lidarrCategory },
          defaultRoot: { movie: cfg.radarrRoot, series: cfg.sonarrRoot, music: cfg.lidarrRoot },
          arrEnabled: {
            movie: !!(cfg.radarrUrl && cfg.radarrKey),
            series: !!(cfg.sonarrUrl && cfg.sonarrKey),
            music: !!(cfg.lidarrUrl && cfg.lidarrKey)
          }
        };
        if (msg.withSpace) out.space = await freeSpace(raw, cfg).catch(() => null); // a hint: it never fails the categories
        return out;
      }
      case 'pagePrefs':
        return { score: scorePrefs(await getConfig()) };
      case 'pageStatus':
        return pageStatus(msg);
      case 'listTorrents':
        return listTorrents();
      case 'qbitIndex': {
        const cfg = await getConfig();
        if (!cfg.listBadges) return { torrents: [] };
        return { torrents: await badgeIndex(msg.hashes) };
      }
      case 'toggleTorrent':
        await toggleTorrent(msg.hash, msg.pause);
        return {};
      case 'arrMeta':
        return arrMeta(msg.service, msg.cfg);
      case 'arm':
        pending = {
          tabId: sender.tab.id, category: msg.category, paused: msg.paused, media: msg.media,
          expires: Date.now() + ARM_TIMEOUT_MS
        };
        return {};
      case 'disarm':
        pending = null;
        return {};
      case 'upload': {
        // Add to Radarr/Sonarr/Lidarr first so it already knows the item when the download completes.
        let arrResult = null;
        let arrError = null;
        try { arrResult = await addToArr(msg.media); } catch (e) { arrError = e.message; }
        await addTorrent(msg);
        return { arrResult, arrError };
      }
      default:
        throw new Error('Message inconnu');
    }
  })()
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
