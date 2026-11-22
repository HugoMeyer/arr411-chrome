const DEFAULTS = {
  qbUrl: '', username: '', password: '', defaultCategory: '',
  radarrUrl: '', radarrKey: '', radarrRoot: '', radarrProfile: '', radarrCategory: '',
  sonarrUrl: '', sonarrKey: '', sonarrRoot: '', sonarrProfile: '', sonarrCategory: '',
  lidarrUrl: '', lidarrKey: '', lidarrRoot: '', lidarrProfile: '', lidarrMetaProfile: '', lidarrCategory: 'lidarr',
  notifyEnabled: true, notifyAll: false, listBadges: true,
  scorePreset: 'equilibre', scoreWeights: { lang: 30, quality: 30, health: 20, size: 20 }
};
const CHECK_FIELDS = ['notifyEnabled', 'notifyAll', 'listBadges'];
const TEXT_FIELDS = ['qbUrl', 'username', 'password', 'radarrUrl', 'radarrKey', 'sonarrUrl', 'sonarrKey', 'lidarrUrl', 'lidarrKey'];
const CAT_FIELDS = ['defaultCategory', 'radarrCategory', 'sonarrCategory', 'lidarrCategory'];
const ARR_FIELDS = ['radarrProfile', 'radarrRoot', 'sonarrProfile', 'sonarrRoot', 'lidarrProfile', 'lidarrMetaProfile', 'lidarrRoot'];
const SELECT_FIELDS = [...CAT_FIELDS, ...ARR_FIELDS];
const ARR_NAMES = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };
const SCORE_PRESETS = ['equilibre', 'qualite', 'vf', 'leger', 'ratio', 'perso'];
const SCORE_HINTS = {
  equilibre: 'Langue et qualité d’abord, puis seeders et taille : le réglage d’origine.',
  qualite: 'La qualité d’image prime : résolution, source, HDR et audio.',
  vf: 'La langue prime : MULTI.VFF et VOF loin devant VF2, VFQ et VOSTFR.',
  leger: 'La taille prime : les versions légères et de bonne qualité passent devant.',
  ratio: 'Les seeders priment, pour faire du ratio. Seules les listes les connaissent pour toutes les versions : sur une fiche, ce profil change peu.',
  perso: 'Choisis toi-même le poids de chaque critère.'
};
const WEIGHT_FIELDS = { lang: 'weightLang', quality: 'weightQuality', health: 'weightHealth', size: 'weightSize' };
const $ = (id) => document.getElementById(id);
let saved = {};

function status(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'err';
}

function fillSelect(sel, items, selected, emptyLabel) {
  sel.innerHTML = '';
  if (emptyLabel) sel.add(new Option(emptyLabel, ''));
  for (const { value, label } of items) sel.add(new Option(label, value));
  if (selected && ![...sel.options].some((o) => o.value === String(selected))) sel.add(new Option(String(selected), selected));
  sel.value = selected || '';
}

function readWeights() {
  const out = {};
  for (const k of Object.keys(WEIGHT_FIELDS)) {
    const v = $(WEIGHT_FIELDS[k]).value.trim();
    out[k] = v === '' ? NaN : Number(v);
  }
  return out;
}

// Integers from 0 to 100, at least one above 0.
const validWeights = (w) => Object.values(w).every((v) => Number.isInteger(v) && v >= 0 && v <= 100)
  && Object.values(w).some((v) => v > 0);

function showScore() {
  const preset = $('scorePreset').value;
  $('scoreHint').textContent = SCORE_HINTS[preset] || '';
  $('scoreCustom').hidden = preset !== 'perso';
}

function readForm() {
  const cfg = {};
  for (const f of TEXT_FIELDS) {
    const v = f === 'password' ? $(f).value : $(f).value.trim();
    cfg[f] = f.endsWith('Url') ? v.replace(/\/+$/, '') : v;
  }
  for (const f of SELECT_FIELDS) cfg[f] = $(f).value;
  for (const f of CHECK_FIELDS) cfg[f] = $(f).checked;
  cfg.qbUrl = cfg.qbUrl || DEFAULTS.qbUrl;
  cfg.scorePreset = SCORE_PRESETS.includes($('scorePreset').value) ? $('scorePreset').value : DEFAULTS.scorePreset;
  // The custom weights are kept while another preset is chosen; unusable ones never replace the saved ones.
  const weights = readWeights();
  cfg.scoreWeights = validWeights(weights) ? weights : (saved.scoreWeights || DEFAULTS.scoreWeights);
  return cfg;
}

async function save() {
  const cfg = readForm();
  if (cfg.scorePreset === 'perso' && !validWeights(readWeights())) {
    status('Score personnalisé : chaque poids doit être un entier de 0 à 100, et l’un d’eux au moins doit dépasser 0.', false);
    return false;
  }
  const origins = [];
  for (const f of ['qbUrl', 'radarrUrl', 'sonarrUrl', 'lidarrUrl']) {
    if (!cfg[f]) continue;
    try { origins.push(new URL(cfg[f]).origin + '/*'); } catch { status(`URL invalide : ${cfg[f]}`, false); return false; }
  }
  if (!(await chrome.permissions.request({ origins }))) { status('Permission refusée', false); return false; }
  await chrome.storage.local.set(cfg);
  saved = cfg;
  status('Enregistré ✔', true);
  return true;
}

async function testQbit() {
  if (!(await save())) return;
  status('Connexion à qBittorrent…', true);
  const res = await chrome.runtime.sendMessage({ type: 'getCategories' });
  if (!res.ok) return status(res.error, false);
  const items = res.categories.map((c) => ({ value: c, label: c }));
  for (const id of CAT_FIELDS) fillSelect($(id), items, saved[id], '(aucune)');
  status(`qBittorrent connecté ✔ ${res.categories.length} catégorie(s).`, true);
}

async function testArr(service) {
  if (!(await save())) return;
  const name = ARR_NAMES[service];
  status(`Connexion à ${name}…`, true);
  const res = await chrome.runtime.sendMessage({ type: 'arrMeta', service, cfg: saved });
  if (!res.ok) return status(res.error, false);
  fillSelect($(service + 'Profile'), res.profiles.map((p) => ({ value: String(p.id), label: p.name })), saved[service + 'Profile'] || String(res.profiles[0]?.id || ''));
  fillSelect($(service + 'Root'), res.roots.map((r) => ({ value: r, label: r })), saved[service + 'Root'] || res.roots[0] || '');
  if (res.metaProfiles) {
    // "None" keeps only the albums added by hand (from C411): a real profile is the safer default.
    const def = res.metaProfiles.find((p) => p.name !== 'None') || res.metaProfiles[0];
    fillSelect($(service + 'MetaProfile'), res.metaProfiles.map((p) => ({
      value: String(p.id), label: p.name === 'None' ? 'None (seulement les albums ajoutés)' : p.name
    })), saved[service + 'MetaProfile'] || String(def ? def.id : ''));
  }
  saved = readForm();
  await chrome.storage.local.set(saved);
  status(`${name} connecté ✔ Profil${res.metaProfiles ? 's' : ''} et dossier racine enregistrés (modifiables ci-dessus).`, true);
}

(async () => {
  saved = await chrome.storage.local.get(DEFAULTS);
  for (const f of TEXT_FIELDS) $(f).value = saved[f];
  for (const f of CAT_FIELDS) fillSelect($(f), [], saved[f], '(aucune)');
  for (const f of ARR_FIELDS) fillSelect($(f), [], saved[f], '(cliquer sur Tester)');
  for (const f of CHECK_FIELDS) $(f).checked = saved[f];
  const weights = { ...DEFAULTS.scoreWeights, ...(saved.scoreWeights && typeof saved.scoreWeights === 'object' ? saved.scoreWeights : {}) };
  for (const k of Object.keys(WEIGHT_FIELDS)) $(WEIGHT_FIELDS[k]).value = String(weights[k]);
  $('scorePreset').value = SCORE_PRESETS.includes(saved.scorePreset) ? saved.scorePreset : DEFAULTS.scorePreset;
  showScore();

  $('scorePreset').onchange = showScore;
  $('save').onclick = save;
  $('test').onclick = testQbit;
  for (const b of document.querySelectorAll('[data-load]')) b.onclick = () => testArr(b.dataset.load);
})();
