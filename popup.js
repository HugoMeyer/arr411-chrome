const $ = (id) => document.getElementById(id);
let tab = 'active';
let data = null;

const PAUSED = /^(paused|stopped)/;
const ERROR = /^(error|missingFiles)$/;

function size(bytes) {
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function eta(s) {
  if (!s || s >= 8640000) return '∞';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
}

function render() {
  const list = $('list');
  if (!data) return;
  $('speeds').textContent = `↓ ${size(data.dlspeed)}/s  ↑ ${size(data.upspeed)}/s`;
  const items = tab === 'active'
    ? data.torrents.filter((t) => t.progress < 1)
    : data.torrents.filter((t) => t.progress >= 1).sort((a, b) => b.completion_on - a.completion_on).slice(0, 20);
  list.replaceChildren();
  if (!items.length) {
    list.innerHTML = `<div class="empty">${tab === 'active' ? 'Aucun téléchargement en cours' : 'Aucun torrent terminé'}</div>`;
    return;
  }
  for (const t of items) {
    const paused = PAUSED.test(t.state);
    const pct = Math.floor(t.progress * 100);
    const el = document.createElement('div');
    el.className = 't';
    el.innerHTML = `
      <div class="row"><span class="name"></span><button class="btn"></button></div>
      <div class="bar"><div></div></div>
      <div class="meta"></div>`;
    el.querySelector('.name').textContent = t.name;
    el.querySelector('.name').title = t.name;
    const bar = el.querySelector('.bar div');
    bar.style.width = pct + '%';
    bar.className = ERROR.test(t.state) ? 'err' : paused ? 'paused' : t.progress >= 1 ? 'done' : '';
    const meta = [];
    if (t.progress < 1) {
      meta.push(`${pct} % de ${size(t.size)}`);
      if (paused) meta.push('en pause');
      else meta.push(`↓ ${size(t.dlspeed)}/s`, `reste ${eta(t.eta)}`);
    } else {
      meta.push(size(t.size), `ratio ${t.ratio.toFixed(2)}`);
      if (t.upspeed) meta.push(`↑ ${size(t.upspeed)}/s`);
      if (paused) meta.push('arrêté');
    }
    if (t.category) meta.push(t.category);
    el.querySelector('.meta').textContent = meta.join(' · ');
    const btn = el.querySelector('.btn');
    btn.textContent = paused ? '▶' : '⏸';
    btn.title = paused ? 'Reprendre' : 'Mettre en pause';
    btn.onclick = async () => {
      btn.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'toggleTorrent', hash: t.hash, pause: !paused });
      if (!res.ok) btn.title = res.error;
      refresh();
    };
    list.append(el);
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'listTorrents' });
  if (!res.ok) {
    $('list').innerHTML = '<div class="error"></div>';
    $('list').firstChild.textContent = res.error + '\nVérifie les options.';
    return;
  }
  data = res;
  render();
}

for (const b of document.querySelectorAll('[data-tab]')) {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    render();
  };
}
$('options').onclick = () => chrome.runtime.openOptionsPage();

function openUrl(raw) {
  try {
    const url = new URL(raw);
    if (['https:', 'http:', 'magnet:'].includes(url.protocol)) chrome.tabs.create({ url: url.href });
  } catch {}
}
$('open').onclick = async () => {
  const { qbUrl = '' } = await chrome.storage.local.get('qbUrl');
  openUrl(qbUrl);
};

// ---------- Update notice ----------
// The extension is installed unpacked from GitHub: nothing else says that a newer version exists.

// ==== version:begin ====
const REPO_URL = 'https://github.com/HugoMeyer/arr411-chrome';
const MANIFEST_URL = 'https://raw.githubusercontent.com/HugoMeyer/arr411-chrome/main/manifest.json';
const UPDATE_CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

// True when the dotted version `a` is newer than `b` ("1.10.0" is newer than "1.9.2"). Anything that is
// not digits separated by dots is never newer.
function isNewer(a, b) {
  const parts = (v) => (/^\d+(?:\.\d+)*$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

// Silent on any error: no network, GitHub down, odd answer...
async function checkUpdate() {
  try {
    const { updateCheck } = await chrome.storage.local.get('updateCheck');
    let latest = updateCheck && typeof updateCheck.latest === 'string' ? updateCheck.latest : '';
    const age = updateCheck && typeof updateCheck.at === 'number' ? Date.now() - updateCheck.at : Infinity;
    if (!(age >= 0 && age < UPDATE_CHECK_EVERY_MS)) {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) return;
      const { version } = await res.json();
      if (typeof version !== 'string') return;
      latest = version;
      await chrome.storage.local.set({ updateCheck: { at: Date.now(), latest } });
    }
    if (!isNewer(latest, chrome.runtime.getManifest().version)) return;
    $('updateText').textContent = `Nouvelle version ${latest} disponible`;
    $('update').hidden = false;
  } catch {}
}
// ==== version:end ====
$('updateOpen').onclick = () => openUrl(REPO_URL);

refresh();
setInterval(refresh, 2000);
checkUpdate();
