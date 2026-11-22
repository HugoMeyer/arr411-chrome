(() => {
  const MARK = 'data-qbt-injected';
  const SCORE = 'data-qbt-score';
  const SCORE_TRACK_PX = 60;
  const ARM_TIMEOUT_MS = 20000;
  const MAX_TORRENT_BYTES = 16 * 1024 * 1024; // same limit as the engine and the native layers
  const TOO_BIG = 'Fichier .torrent trop volumineux (16 Mo maximum)';
  let armTimer = null;
  let awaitingTorrent = false;

  const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'Pas de réponse' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension mise à jour : recharge la page (F5).' });
      }
    });
  }

  function toast(text, isError = false, neutral = false) {
    let box = document.getElementById('qbt-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'qbt-toasts';
      Object.assign(box.style, {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: 2147483647,
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end'
      });
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      padding: '12px 16px', borderRadius: '8px', font: '14px system-ui, sans-serif',
      color: '#fff', background: neutral ? '#334155' : isError ? '#c0392b' : '#27ae60',
      boxShadow: '0 4px 16px rgba(0,0,0,.3)', maxWidth: '400px', whiteSpace: 'pre-line'
    });
    box.appendChild(el);
    setTimeout(() => el.remove(), neutral ? 9000 : isError ? 8000 : 5000);
  }

  const MUSIC_SOURCES = ['Deezer', 'MusicBrainz', 'Discogs', 'NFO (partiel)'];

  // C411 music card: purple border, album title in the h3, artist in p[title], MusicBrainz/Deezer/Discogs links.
  function detectMusic() {
    const card = [...document.querySelectorAll('div.border-l-purple-500')].find((d) => d.querySelector('h3') &&
      [...d.querySelectorAll('span')].some((s) => MUSIC_SOURCES.includes(norm(s))));
    if (!card) return null;
    const h3 = card.querySelector('h3');
    let album = [...h3.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent)
      .join(' ').replace(/\s+/g, ' ').trim();
    if (album === 'Album inconnu') album = '';
    const year = ((h3.querySelector('span') || {}).textContent || '').match(/\b(19|20)\d{2}\b/);
    const artistEl = [...card.querySelectorAll('p[title]')].find((p) => !/^Crédits/.test(norm(p)));
    const ids = {};
    const MB = { 'release-group': 'mbReleaseGroup', release: 'mbRelease', artist: 'mbArtist' };
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.href;
      let m;
      if ((m = href.match(/musicbrainz\.org\/(release-group|release|artist)\/([0-9a-f-]{36})/i))) ids[MB[m[1].toLowerCase()]] = m[2].toLowerCase();
      else if ((m = href.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/i))) ids.deezer = m[1];
      else if ((m = href.match(/discogs\.com\/(?:[^?#]*\/)?release\/(\d+)/i))) ids.discogs = m[1];
    }
    return {
      type: 'music', ids, fromCard: true, seasons: [], album, year: year ? year[0] : '',
      artist: artistEl ? artistEl.getAttribute('title').trim() : ''
    };
  }

  // Without a music card: "Artiste - Album (2001) [FLAC]" or scene style "Artiste-Album-WEB-2001-GROUPE".
  function guessMusic(title = pageTitle()) {
    const t = title.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    let parts = t.split(/\s+[-–—]\s+/);
    if (parts.length < 2) parts = t.replace(/[._]/g, ' ').split('-');
    const clean = (s) => (s || '').replace(/\(([^)]*)\)/g, (m, x) => (/^(19|20)\d{2}$/.test(x.trim()) ? ' ' : m))
      .replace(/\s(19|20)\d{2}\b.*$/, '').replace(/\s+/g, ' ').trim();
    const year = t.match(/\b(19|20)\d{2}\b/);
    return { artist: clean(parts[0]), album: clean(parts[1]), year: year ? year[0] : '' };
  }

  function detectMedia() {
    const label = [...document.querySelectorAll('span')].find((s) => norm(s) === 'Fiches :');
    if (!label) {
      const music = detectMusic();
      if (music) return music;
    }
    let links = label ? [...label.parentElement.querySelectorAll('a[href]')] : [];
    if (!links.length) links = [...document.querySelectorAll('a[href]')];

    const ids = {};
    for (const a of links) {
      const href = a.href;
      let m;
      if (!ids.imdb && (m = href.match(/imdb\.com\/title\/(tt\d+)/))) ids.imdb = m[1];
      else if (!ids.tmdb && (m = href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/))) { ids.tmdbKind = m[1]; ids.tmdb = m[2]; }
      else if (!ids.tvdb && (m = href.match(/thetvdb\.com\/.*\bseries\/(\d+)/))) ids.tvdb = m[1];
    }
    const type = ids.tmdbKind === 'tv' || ids.tvdb ? 'series' : ids.tmdbKind === 'movie' ? 'movie' : '';
    return { type, ids, fromFiches: !!label, seasons: type === 'series' ? detectSeasons() : [] };
  }

  function pageTitle() {
    const h1 = document.querySelector('h1');
    return h1 ? norm(h1) : document.title;
  }

  // "S01", "S02E05", "S01-S03" → [1], [2], [1, 2, 3]. Complete packs without Sxx → [].
  function detectSeasons(title = pageTitle()) {
    const found = new Set();
    for (const m of title.matchAll(/S(\d{1,2})\s*-\s*S(\d{1,2})(?![0-9])/gi)) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      if (b - a <= 50) for (let n = a; n <= b; n++) found.add(n);
    }
    for (const m of title.matchAll(/(?:^|[^A-Za-z0-9])S(\d{1,2})(?=E\d|[^A-Za-z0-9]|$)/g)) found.add(Number(m[1]));
    return [...found].sort((a, b) => a - b);
  }

  const pageHashFromUrl = () => {
    const m = location.pathname.match(/\/torrents\/([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : '';
  };

  function detectHash() {
    const fromUrl = pageHashFromUrl();
    if (fromUrl) return fromUrl;
    const label = [...document.querySelectorAll('span, div, dt, p')].find((el) => /^Hash\s*:?$/i.test(norm(el)));
    const scope = label ? label.parentElement : document.body;
    const m = (scope.textContent || '').match(/\b([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : '';
  }

  // ---------- Status badge (duplicates / library) ----------

  let badge = null;
  let lastStatus = null;
  let statusKey = '';
  let statusRequest = 0;

  function badgeEl() {
    const ours = document.querySelector(`button[${MARK}="ours"]`);
    if (!ours) return null;
    if (!badge) {
      badge = document.createElement('span');
      Object.assign(badge.style, {
        display: 'inline-flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
        marginLeft: '0.5rem', font: '12px system-ui, sans-serif', verticalAlign: 'middle'
      });
    }
    if (badge.previousElementSibling !== ours) ours.insertAdjacentElement('afterend', badge);
    return badge;
  }

  function pill(text, color, title) {
    const el = document.createElement('span');
    el.textContent = text;
    if (title) el.title = title;
    Object.assign(el.style, {
      padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
      background: color + '26', color, border: `1px solid ${color}66`
    });
    return el;
  }

  const QB_STATES = {
    downloading: 'téléchargement', stalledDL: 'en attente', metaDL: 'métadonnées', forcedDL: 'téléchargement',
    queuedDL: 'en file', pausedDL: 'en pause', stoppedDL: 'en pause', checkingDL: 'vérification',
    uploading: 'seed', stalledUP: 'seed', forcedUP: 'seed', queuedUP: 'seed (file)', pausedUP: 'terminé',
    stoppedUP: 'terminé', checkingUP: 'vérification', error: 'erreur', missingFiles: 'fichiers manquants'
  };

  function qbitText(q) {
    const pct = Math.floor((q.progress || 0) * 100);
    return `qBittorrent : ${pct >= 100 ? 'complet' : pct + ' %'} · ${QB_STATES[q.state] || q.state}`;
  }

  function renderBadge() {
    const el = badgeEl();
    if (!el) return;
    el.replaceChildren();
    const s = lastStatus;
    if (!s) return;
    if (s.qbit) el.append(pill('⚠ ' + qbitText(s.qbit), '#f59e0b', s.qbit.name + (s.qbit.category ? ` — catégorie : ${s.qbit.category}` : '')));
    const lib = s.library;
    if (!lib) return;
    if (!lib.inLibrary) { el.append(pill(`Pas dans ${lib.service}`, '#9ca3af')); return; }
    if (lib.service === 'Lidarr') {
      if (lib.artistOnly) el.append(pill('Lidarr : artiste présent, album absent', '#9ca3af', lib.title));
      else if (!lib.total) el.append(pill('Lidarr : album présent', '#3b82f6', lib.title));
      else {
        const complete = lib.files >= lib.total;
        el.append(pill(`${complete ? '✔ ' : ''}Lidarr : ${lib.files}/${lib.total} pistes`, complete ? '#22c55e' : '#3b82f6', lib.title));
      }
      return;
    }
    if (lib.service === 'Radarr') {
      el.append(pill(lib.hasFile ? '✔ Radarr : fichier présent' : 'Radarr : fichier manquant',
        lib.hasFile ? '#22c55e' : '#3b82f6', lib.title));
      return;
    }
    if (lib.seasons && lib.seasons.length) {
      for (const se of lib.seasons) {
        const name = 'S' + String(se.number).padStart(2, '0');
        if (!se.exists) { el.append(pill(`Sonarr : ${name} inconnue`, '#9ca3af', lib.title)); continue; }
        const complete = se.total > 0 && se.files >= se.total;
        el.append(pill(`${complete ? '✔ ' : ''}Sonarr ${name} : ${se.files}/${se.total} ép.`,
          complete ? '#22c55e' : '#3b82f6', lib.title));
      }
    } else {
      el.append(pill(`Sonarr : ${lib.files}/${lib.total} ép.`, '#3b82f6', lib.title));
    }
  }

  async function refreshStatus(force = false) {
    if (!document.querySelector(`button[${MARK}="ours"]`)) return;
    const media = detectMedia();
    const hash = detectHash();
    const useMedia = (media.fromFiches || media.fromCard) && media.type;
    const key = [location.pathname, hash, useMedia ? JSON.stringify(media) : ''].join('|');
    if (!force && key === statusKey) { renderBadge(); return; }
    statusKey = key;
    lastStatus = null;
    renderBadge();
    if (!hash && !useMedia) return;
    const reqId = ++statusRequest;
    const res = await send({ type: 'pageStatus', hash, media: useMedia ? media : null });
    if (reqId !== statusRequest || !res.ok) return;
    lastStatus = res;
    renderBadge();
  }

  // ==== space:begin ====
  const GIB = 1073741824;

  // Sizes counted like the page and qBittorrent do (powers of 1024), with French unit names and decimal comma.
  function formatBytes(bytes) {
    const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
    let v = Math.max(0, bytes);
    let u = 0;
    while (v >= 1023.5 && u < units.length - 1) { v /= 1024; u++; }
    const digits = u === 0 || v >= 100 ? 0 : 1;
    return `${v.toFixed(digits).replace('.', ',').replace(/,0$/, '')} ${units[u]}`;
  }

  // What the send dialog says about the disk for the chosen category: { info, warn } ('' = nothing to say).
  // space: the `space` of the getCategories reply (null when qBittorrent can't tell); sizeGB: the torrent's size,
  // null when unknown. A torrent that would leave less than 1 Gio free is warned about.
  function spaceNote(space, category, sizeGB) {
    const note = { info: '', warn: '' };
    if (!space || typeof space !== 'object') return note;
    const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
    const path = category ? (own(space.categoryPaths, category) ? space.categoryPaths[category] : null) : space.defaultPath;
    const free = typeof path === 'string' && own(space.byPath, path) ? space.byPath[path] : null;
    if (typeof free !== 'number' || !isFinite(free) || free < 0) return note;
    note.info = `Espace libre : ${formatBytes(free)}`;
    if (typeof sizeGB === 'number' && isFinite(sizeGB) && sizeGB > 0 && sizeGB * GIB > free - GIB) {
      note.warn = `⚠ Espace disque insuffisant : ce torrent fait ${formatBytes(sizeGB * GIB)}, il reste ${formatBytes(free)}.`;
    }
    return note;
  }
  // ==== space:end ====

  // The size of the torrent being sent, in GiB: the one of the torrent page, or of the clicked row. Null when unknown.
  const torrentSize = (ctx) => {
    try { return ctx ? ctx.sizeGB : (pageStats() || {}).sizeGB; } catch (e) { return null; }
  };

  // ctx (list rows): { name, qbit, sizeGB } — no Radarr/Sonarr/Lidarr IDs are available outside the torrent page.
  function chooseCategory(ctx = null) {
    const listMode = !!ctx;
    const detected = listMode ? { type: '', ids: {} } : detectMedia();
    const knownQbit = listMode ? ctx.qbit : lastStatus && lastStatus.qbit;
    const idsText = [
      detected.ids.imdb && `IMDb ${detected.ids.imdb}`,
      detected.ids.tmdb && `TMDB ${detected.ids.tmdb}`,
      detected.ids.tvdb && `TVDB ${detected.ids.tvdb}`,
      (detected.ids.mbRelease || detected.ids.mbReleaseGroup) && 'MusicBrainz',
      detected.ids.deezer && `Deezer ${detected.ids.deezer}`,
      detected.ids.discogs && `Discogs ${detected.ids.discogs}`
    ].filter(Boolean).join(' · ') || 'aucun ID trouvé';

    return new Promise(async (resolve) => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 2147483646;
                display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
          .box { background: #1e1e24; color: #eee; border-radius: 10px; padding: 20px; width: 340px;
                 max-height: 92vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
          h3 { margin: 0 0 14px; font-size: 16px; }
          select { width: 100%; padding: 8px; border-radius: 6px; background: #2b2b33; color: #eee; border: 1px solid #444; }
          label { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
          .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
          button { padding: 8px 14px; border-radius: 6px; border: 0; cursor: pointer; font-weight: 600; }
          .ok { background: #3b82f6; color: #fff; } .ok:disabled { opacity: .5; cursor: default; }
          .cancel { background: #3a3a44; color: #eee; }
          .err { color: #ff7b72; margin-top: 10px; white-space: pre-wrap; }
          .lbl { margin: 12px 0 4px; font-weight: 600; } .lbl:first-of-type { margin-top: 0; }
          .ids { margin-top: 4px; font-size: 12px; color: #999; }
          .warn { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b66; border-radius: 6px;
                  padding: 8px 10px; margin-bottom: 12px; }
          input[type=text] { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px;
                  background: #2b2b33; color: #eee; border: 1px solid #444; }
          .hint { font-size: 12px; color: #999; margin-top: 4px; }
          .space { font-size: 12px; color: #999; margin-top: 4px; }
          .lowspace { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b66; border-radius: 6px;
                  padding: 8px 10px; margin-top: 8px; }
          .tname { font-size: 12px; color: #bbb; margin: -6px 0 12px; word-break: break-all; }
          .listhint { margin: 0 0 4px; }
        </style>
        <div class="bg">
          <div class="box">
            <h3>Envoyer à qBittorrent</h3>
            <div class="tname" hidden></div>
            <div class="warn" hidden></div>
            <div class="arrsel">
            <div class="lbl">Ajouter à</div>
            <select class="type">
              <option value="">Ne pas ajouter</option>
              <option value="movie">Radarr (film)</option>
              <option value="series">Sonarr (série)</option>
              <option value="music">Lidarr (musique)</option>
            </select>
            <div class="ids">${idsText}</div>
            </div>
            <div class="ids listhint" hidden>Radarr/Sonarr/Lidarr : ouvre la fiche du torrent pour l’ajout automatique.</div>
            <div class="arr" hidden>
              <div class="lbl">Dossier racine</div>
              <select class="root" disabled><option>Chargement…</option></select>
              <div class="stype-wrap" hidden>
                <div class="lbl">Type de série</div>
                <select class="stype">
                  <option value="standard">Standard</option>
                  <option value="anime">Anime</option>
                  <option value="daily">Quotidienne</option>
                </select>
              </div>
              <div class="music-wrap" hidden>
                <div class="lbl">Ajouter dans Lidarr</div>
                <select class="lmode">
                  <option value="album">L’album (et l’artiste si besoin)</option>
                  <option value="artist">L’artiste seul</option>
                </select>
                <div class="lbl">Artiste</div>
                <input type="text" class="artist" placeholder="Nom de l’artiste">
                <div class="album-wrap">
                  <div class="lbl">Album</div>
                  <input type="text" class="album" placeholder="Titre de l’album">
                </div>
              </div>
            </div>
            <div class="lbl">Catégorie qBittorrent</div>
            <select class="cat" disabled><option>Chargement des catégories…</option></select>
            <div class="space" hidden></div>
            <div class="lowspace" hidden></div>
            <label><input type="checkbox" class="paused"> Ajouter en pause</label>
            <div class="err" hidden></div>
            <div class="row">
              <button class="cancel">Annuler</button>
              <button class="ok" disabled>Envoyer</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(host);
      // Typing in our fields must not trigger C411 keyboard shortcuts.
      for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());

      const select = root.querySelector('.cat');
      const typeSelect = root.querySelector('.type');
      const rootSelect = root.querySelector('.root');
      const stypeSelect = root.querySelector('.stype');
      const lmodeSelect = root.querySelector('.lmode');
      const artistInput = root.querySelector('.artist');
      const albumInput = root.querySelector('.album');
      const arrBox = root.querySelector('.arr');
      const warn = root.querySelector('.warn');
      const spaceInfo = root.querySelector('.space');
      const spaceWarn = root.querySelector('.lowspace');
      const sizeGB = torrentSize(ctx);
      const SERVICE = { movie: 'radarr', series: 'sonarr', music: 'lidarr' };
      const guess = detected.type === 'music' ? detected : guessMusic();
      artistInput.value = guess.artist || '';
      albumInput.value = guess.album || '';
      lmodeSelect.onchange = () => { root.querySelector('.album-wrap').hidden = lmodeSelect.value === 'artist'; };
      // Names edited by hand: the MusicBrainz IDs found on the page may no longer match.
      const musicMedia = () => {
        const artist = artistInput.value.trim();
        const album = albumInput.value.trim();
        const sameArtist = detected.type === 'music' && artist === (detected.artist || '');
        const sameAlbum = sameArtist && album === (detected.album || '');
        return {
          type: 'music', artist, album, year: guess.year, rootFolder: rootSelect.value, lmode: lmodeSelect.value,
          ids: sameAlbum ? detected.ids : sameArtist && detected.ids.mbArtist ? { mbArtist: detected.ids.mbArtist } : {}
        };
      };
      if (knownQbit) {
        warn.hidden = false;
        warn.textContent = `⚠ Ce torrent est déjà dans qBittorrent (${qbitText(knownQbit).replace('qBittorrent : ', '')}).`;
      }
      if (listMode) {
        root.querySelector('.arrsel').hidden = true;
        root.querySelector('.listhint').hidden = false;
        if (ctx.name) { const n = root.querySelector('.tname'); n.hidden = false; n.textContent = ctx.name; }
      }
      const ok = root.querySelector('.ok');
      const err = root.querySelector('.err');
      const close = (value) => { host.remove(); resolve(value); };

      root.querySelector('.cancel').onclick = () => close(null);
      root.querySelector('.bg').onclick = (e) => { if (e.target.classList.contains('bg')) close(null); };
      root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && !ok.disabled) ok.click(); });
      ok.onclick = () => close({
        category: select.value,
        paused: root.querySelector('.paused').checked,
        media: typeSelect.value === 'music' ? musicMedia() : typeSelect.value ? {
          type: typeSelect.value,
          ids: detected.ids,
          rootFolder: rootSelect.value,
          seriesType: typeSelect.value === 'series' ? stypeSelect.value : undefined
        } : null
      });

      const res = await send({ type: 'getCategories', withSpace: true });
      if (!res.ok) {
        select.innerHTML = '<option value="">(aucune catégorie)</option>';
        err.hidden = false;
        err.textContent = res.error + '\nVérifie les options de l’extension.';
        return;
      }
      select.innerHTML = '';
      select.add(new Option('(aucune catégorie)', ''));
      for (const c of res.categories) select.add(new Option(c, c));
      select.value = res.categories.includes(res.selected) ? res.selected : '';

      for (const opt of typeSelect.options) {
        if (opt.value && !res.arrEnabled[opt.value]) { opt.disabled = true; opt.textContent += ' — non configuré'; }
      }
      const hasIds = detected.type === 'music' || detected.ids.imdb || detected.ids.tmdb || detected.ids.tvdb;
      typeSelect.value = hasIds && res.arrEnabled[detected.type] ? detected.type : '';
      // Non-blocking: the free space of the chosen category, and a warning when the torrent might not fit.
      const showSpace = () => {
        const note = spaceNote(res.space, select.value, sizeGB);
        spaceInfo.hidden = !note.info;
        spaceInfo.textContent = note.info;
        spaceWarn.hidden = !note.warn;
        spaceWarn.textContent = note.warn;
        ok.textContent = note.warn ? 'Envoyer quand même' : 'Envoyer';
      };
      select.onchange = showSpace;
      const applyTypeCategory = () => {
        const cat = res.byType[typeSelect.value];
        if (cat && res.categories.includes(cat)) select.value = cat;
        showSpace();
      };
      const guessSeriesType = () => {
        stypeSelect.value = /anim/i.test(rootSelect.value) ? 'anime' : 'standard';
      };
      rootSelect.onchange = guessSeriesType;
      let rootsRequest = 0;
      const loadRoots = async () => {
        const kind = typeSelect.value;
        arrBox.hidden = !kind;
        root.querySelector('.stype-wrap').hidden = kind !== 'series';
        root.querySelector('.music-wrap').hidden = kind !== 'music';
        if (!kind) { rootsRequest++; err.hidden = true; ok.disabled = false; return; }
        const reqId = ++rootsRequest;
        rootSelect.disabled = true;
        ok.disabled = true;
        rootSelect.innerHTML = '<option>Chargement…</option>';
        const meta = await send({ type: 'arrMeta', service: SERVICE[kind] });
        if (reqId !== rootsRequest) return;
        rootSelect.innerHTML = '';
        if (!meta.ok || !meta.roots.length) {
          err.hidden = false;
          err.textContent = meta.ok ? 'Aucun dossier racine configuré.' : meta.error;
          return;
        }
        err.hidden = true;
        for (const r of meta.roots) rootSelect.add(new Option(r, r));
        const def = res.defaultRoot[kind];
        rootSelect.value = meta.roots.includes(def) ? def : meta.roots[0];
        guessSeriesType();
        rootSelect.disabled = false;
        ok.disabled = false;
      };
      typeSelect.onchange = () => { applyTypeCategory(); loadRoots(); };
      applyTypeCategory();

      select.disabled = false;
      ok.disabled = false;
      ok.focus();
      loadRoots();
    });
  }

  function clickNormalDownloadIfOffered() {
    const deadline = Date.now() + 5000;
    const tryClick = () => {
      const label = [...document.querySelectorAll('span, div, button, a')]
        .find((el) => norm(el) === 'Téléchargement normal' && el.offsetParent !== null);
      if (label) {
        (label.closest('button, a, [role="menuitem"], [role="option"], [role="button"], li') || label).click();
        return;
      }
      if (Date.now() < deadline) setTimeout(tryClick, 150);
    };
    setTimeout(tryClick, 150);
  }

  async function sendToQbit(nativeButton, ctx = null) {
    const choice = await chooseCategory(ctx);
    if (!choice) return;

    const armed = await send({ type: 'arm', ...choice });
    if (!armed.ok) return toast(armed.error, true);

    awaitingTorrent = true;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      awaitingTorrent = false;
      send({ type: 'disarm' });
      toast('Aucun téléchargement détecté. Réessaie.', true);
    }, ARM_TIMEOUT_MS);

    nativeButton.click();
    clickNormalDownloadIfOffered();
  }

  async function handleTorrent({ url, filename, category, paused, media }) {
    clearTimeout(armTimer);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`Téléchargement du .torrent impossible (${res.status})`);
      if (Number(res.headers && res.headers.get('content-length')) > MAX_TORRENT_BYTES) throw new Error(TOO_BIG);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_TORRENT_BYTES) throw new Error(TOO_BIG);
      const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
      if (head[0] !== 'd' || !new TextDecoder('latin1').decode(bytes).includes('4:info')) {
        throw new Error('Le fichier récupéré n’est pas un .torrent valide');
      }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const up = await send({ type: 'upload', base64: btoa(bin), filename, category, paused, media });
      if (!up.ok) throw new Error(up.error);
      toast(`Envoyé à qBittorrent${category ? ` (catégorie : ${category})` : ''} ✔`);
      if (up.arrResult) toast(`✔ ${up.arrResult}`);
      if (up.arrError) toast(up.arrError, true);
      setTimeout(() => { refreshStatus(true); qbIndex = null; refreshListBadges(); }, 1500);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // Only answers a download this page armed itself: on Android and Desktop the page world can reach this listener.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'fetchTorrent' || !awaitingTorrent || typeof msg.url !== 'string') return;
    awaitingTorrent = false;
    handleTorrent(msg);
  });

  // ---------- qBittorrent buttons: torrent page, and right after each download icon in lists ----------

  // Native download button -> our button. C411's own elements are never modified (Vue may re-render or
  // reuse them); our button is recreated whenever it is no longer in the page.
  const pairs = new Map();

  function pairUp(native, make) {
    const ours = pairs.get(native);
    if (ours && ours.isConnected) return;
    const el = make();
    pairs.set(native, el);
    native.insertAdjacentElement('afterend', el);
  }

  function sweepPairs() {
    for (const [native, ours] of pairs) {
      if (native.isConnected && ours.isConnected) continue;
      if (!native.isConnected) ours.remove();
      pairs.delete(native);
    }
  }

  function pageButton(btn) {
    const ours = btn.cloneNode(false);
    ours.removeAttribute('id');
    ours.setAttribute(MARK, 'ours');
    const icon = btn.querySelector('[data-slot="leadingIcon"], .iconify, svg');
    if (icon) ours.append(icon.cloneNode(true));
    ours.append(document.createTextNode(icon ? ' qBittorrent' : '⇩ qBittorrent'));
    ours.title = 'Envoyer à qBittorrent';
    ours.style.marginLeft = '0.5rem';
    ours.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted) sendToQbit(btn);
    });
    return ours;
  }

  // `includes` first: most elements have no such class, and splitting every class list is what made a scan slow.
  const gridToken = (el) => (typeof el.className === 'string' && el.className.includes('lg:grid-cols-[')
    ? (el.className.split(/\s+/).find((c) => c.startsWith('lg:grid-cols-[')) || '') : '');

  // Result rows are CSS grids whose columns come from a `lg:grid-cols-[…]` class. Only a few levels up
  // are checked, so that a page-layout grid is never taken for a row.
  function rowGrid(btn) {
    let el = btn.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) if (gridToken(el)) return el;
    return null;
  }

  // On desktop, the download-icon column (the last one) is doubled so that our icon fits next to C411's,
  // and a column is added after it for the score badge.
  // The rule targets the class itself: rows and header sharing it stay aligned, rows added later are
  // covered, and the mobile layout (below Tailwind's `lg` breakpoint) is left untouched.
  const widenedGrids = new Set();
  const scoredGrids = new Set();

  // '' when the last track is not a fixed size: such a template is left alone.
  function gridRule(token) {
    const cols = token.slice('lg:grid-cols-['.length, -1).split('_');
    const last = /^(\d+(?:\.\d+)?)px$/.exec(cols[cols.length - 1]);
    if (!last) return '';
    if (widenedGrids.has(token)) cols[cols.length - 1] = `${Number(last[1]) * 2}px`;
    if (scoredGrids.has(token)) cols.push(`${SCORE_TRACK_PX}px`);
    const sel = `.${CSS.escape(token)}`;
    return `@media (min-width: 64rem) { ${sel}${sel} { grid-template-columns: ${cols.join(' ')}; } }`;
  }

  function applyGridRules() {
    const css = [...new Set([...widenedGrids, ...scoredGrids])].map(gridRule).filter(Boolean).join('\n');
    if (!css) return;
    let style = document.getElementById('qbt-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'qbt-style';
      style.setAttribute(MARK, 'style');
      (document.head || document.documentElement).append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  function rowLink(row) {
    const wrapping = row.closest('a[href*="/torrents/"]');
    if (wrapping) return wrapping;
    let el = row.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      const links = [...el.querySelectorAll('a[href*="/torrents/"]')]
        .filter((a) => /\/torrents\/[^/?#]+/.test(a.getAttribute('href')));
      const uniq = [...new Set(links.map((a) => a.getAttribute('href')))];
      if (uniq.length === 1) return links.find((a) => norm(a)) || links[0];
      if (uniq.length > 1) return null;
    }
    return null;
  }

  function listButton(btn, row) {
    const ours = btn.cloneNode(true);
    for (const attr of ['id', 'data-state', 'data-grace-area-trigger']) ours.removeAttribute(attr);
    ours.setAttribute(MARK, 'ours-list');
    ours.setAttribute('aria-label', 'Envoyer à qBittorrent');
    ours.title = 'Envoyer à qBittorrent';
    ours.style.color = '#60a5fa';
    ours.style.marginLeft = '2px';
    ours.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      const a = rowLink(row);
      let qbit = null;
      if (a) {
        const t = matchAnchor(a, await loadIndex());
        if (t) qbit = { name: t.name, progress: t.progress, state: t.state };
      }
      // innerText: only the layout shown at this screen size (rows hold both a desktop and a mobile one).
      const name = a ? (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim() : '';
      sendToQbit(btn, { name, qbit, sizeGB: rowSize(row) || (a ? rowSize(a) : null) });
    });
    return ours;
  }

  // The size a result row shows (its first cell that reads as one), in GiB. Null when it shows none.
  function rowSize(el) {
    for (const c of cellsOf(el)) {
      const size = parseSize(c.text);
      if (size !== null) return size;
    }
    return null;
  }

  const hasDownloadIcon = (btn) => !!btn.querySelector('[class*="arrow-down-tray"]');

  function inject() {
    sweepPairs();
    for (const btn of document.querySelectorAll('button')) {
      if (btn.hasAttribute(MARK)) continue;
      const text = norm(btn);
      if (text === 'Télécharger') { pairUp(btn, () => pageButton(btn)); continue; }
      if (text) continue;
      const grid = rowGrid(btn);
      const label = btn.getAttribute('aria-label');
      // Desktop rows and search "media" rows label their download icon; the mobile result cards don't.
      const listed = label === 'Télécharger'
        || (label === null && !grid && hasDownloadIcon(btn) && !!btn.closest('a[href*="/torrents/"]'));
      if (!listed) continue;
      if (grid) widenedGrids.add(gridToken(grid));
      pairUp(btn, () => listButton(btn, grid || btn.parentElement));
    }
    applyGridRules();
  }

  // ---------- List badges (search results, etc.) ----------

  const PILL = 'data-qbt-pill';
  const normName = (s) => (s || '').toLowerCase().replace(/\.torrent$/, '').replace(/[^a-z0-9]+/g, '');
  let qbIndex = null; // { byName: Map, byHash: Map, at }

  // The torrents of the page, by hash: a library too big to be listed whole is asked about them directly.
  function pageHashes() {
    const found = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(/[a-f0-9]{40}/i);
      if (m) found.add(m[0].toLowerCase());
      if (found.size >= 300) break;
    }
    return [...found];
  }

  async function loadIndex() {
    const hashes = pageHashes();
    const age = qbIndex ? Date.now() - qbIndex.at : Infinity;
    if (qbIndex && age < 30000 && (age < 3000 || hashes.every((h) => qbIndex.asked.has(h)))) return qbIndex;
    const res = await send({ type: 'qbitIndex', hashes });
    const torrents = res.ok ? res.torrents : [];
    qbIndex = {
      at: Date.now(),
      asked: new Set(hashes),
      byName: new Map(torrents.map((t) => [normName(t.name), t])),
      byHash: new Map(torrents.map((t) => [t.hash, t]))
    };
    return qbIndex;
  }

  function matchAnchor(a, idx) {
    const h = (a.getAttribute('href') || '').match(/[a-f0-9]{40}/i);
    if (h && idx.byHash.has(h[0].toLowerCase())) return idx.byHash.get(h[0].toLowerCase());
    const candidates = [a.title, norm(a)];
    for (const el of a.querySelectorAll('*')) if (!el.children.length) candidates.push(el.textContent);
    for (const c of candidates) {
      const k = normName(c);
      if (k.length >= 12 && idx.byName.has(k)) return idx.byName.get(k);
    }
    return null;
  }

  // Where to put the pill: next to the "copy file name" button of the result row, if any.
  function pillSlots(a) {
    let el = a;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      const btns = el.querySelectorAll('button[aria-label="Copier le nom du fichier"]');
      if (btns.length && btns.length <= 2) return [...btns].map((b) => ({ ref: b, where: 'beforebegin' }));
      if (btns.length > 2) break;
    }
    // Card-like links (e.g. notifications): put it at the end of the last text line, inside the link.
    const lines = a.querySelectorAll('p');
    if (lines.length) return [{ ref: lines[lines.length - 1], where: 'beforeend' }];
    return [{ ref: a, where: 'afterend' }];
  }

  function existingPillAt(ref, where) {
    let el = where === 'beforebegin' ? ref.previousElementSibling
      : where === 'beforeend' ? ref.lastElementChild
        : ref.nextElementSibling;
    // A score badge may sit between the reference and the pill.
    while (el && el.hasAttribute(SCORE)) el = where === 'afterend' ? el.nextElementSibling : el.previousElementSibling;
    return !!(el && el.hasAttribute(PILL));
  }

  const anchorPills = new WeakMap();

  async function refreshListBadges() {
    const idx = await loadIndex();
    if (!idx.byName.size) return;
    const onDetail = !!document.querySelector(`button[${MARK}="ours"]`);
    const currentHash = pageHashFromUrl() || (onDetail ? detectHash() : '');
    const h1 = onDetail ? document.querySelector('h1') : null;
    const titleKey = h1 ? normName(h1.textContent) : '';
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest(`[${PILL}]`) || a.closest('#qbt-toasts')) continue;
      // The torrent of the current page is already shown next to the qBittorrent button.
      const selfLink = currentHash && (a.getAttribute('href') || '').toLowerCase().includes(currentHash);
      const hidden = !a.getClientRects().length;
      if (selfLink || hidden) {
        (anchorPills.get(a) || []).forEach((p) => p.remove());
        anchorPills.delete(a);
        continue;
      }
      let t = matchAnchor(a, idx);
      if (t && ((currentHash && t.hash === currentHash) || (titleKey.length >= 12 && normName(t.name) === titleKey))) t = null;
      let pills = (anchorPills.get(a) || []).filter((p) => p.isConnected);
      if (!t) { pills.forEach((p) => p.remove()); anchorPills.delete(a); continue; }
      const done = t.progress >= 1;
      const text = done ? '✔ qBit' : `⇩ ${Math.floor(t.progress * 100)} %`;
      if (!pills.length) {
        pills = pillSlots(a)
          .filter(({ ref, where }) => !existingPillAt(ref, where))
          .map(({ ref, where }) => {
            const p = pill(text, done ? '#22c55e' : '#3b82f6', `Déjà dans qBittorrent : ${t.name}`);
            p.setAttribute(PILL, '');
            Object.assign(p.style, { fontSize: '10px', padding: '1px 6px', flexShrink: '0', lineHeight: '1.4' });
            if (where !== 'beforebegin') p.style.marginLeft = '6px';
            if (where === 'beforeend') p.style.display = 'inline-block';
            ref.insertAdjacentElement(where, p);
            return p;
          });
        anchorPills.set(a, pills);
      } else {
        for (const p of pills) if (p.textContent !== text) p.textContent = text;
      }
    }
  }

  // ---------- Scoring badges: release parsing and score ----------

  // ==== scoring:begin ====
  // Pure part: nothing in this block touches the DOM. test/scoring.test.js evaluates it as it is.
  const QUALITY_EXP = 2;
  const SIZE_EXP = 0.55;
  const WEIGHTS = { lang: 30, quality: 30, health: 20, size: 20 };
  const QUALITY_MAX = { res: 12, src: 8, hdr: 4, audio: 4, codec: 2 };
  const LANG_MAX = 30;
  const LANG_UNKNOWN = 6;
  const DEAD_CAP = 35;

  // Lowercase, no accents, dot-separated: each token can be matched as `.token.`.
  const flat = (s) => '.' + String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/hdr10\+/g, 'hdr10plus').replace(/dd\+/g, 'ddp').replace(/e-ac-3/g, 'eac3')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') + '.';

  // [pattern, points, label]. For languages, resolutions and sources the first match wins.
  const LANGS = [
    [/\.multi\.(?:vff|truefrench)\./, 30, 'MULTI.VFF'],
    [/\.multi\.vof\./, 30, 'MULTI.VOF'],
    [/\.multi\.vf2\./, 29, 'MULTI.VF2'],
    [/\.multi\.vfi\./, 27, 'MULTI.VFi'],
    [/\.multi\.vfq\./, 26, 'MULTI.VFQ'],
    [/\.multi\./, 25, 'MULTI'],
    [/\.vof\./, 30, 'VOF'],
    [/\.(?:vff|truefrench)\./, 24, 'VFF'],
    [/\.vf2\./, 23, 'VF2'],
    [/\.(?:french|vf)\./, 21, 'FRENCH'],
    [/\.vfi\./, 20, 'VFi'],
    [/\.vfq\./, 18, 'VFQ'],
    [/\.(?:vostfr|subfrench)\./, 10, 'VOSTFR'],
    [/\.vost\./, 8, 'VOST'],
    [/\.vo\./, 4, 'VO']
  ];
  const RESOLUTIONS = [
    [/\.(?:2160p|4k|uhd)\./, 12, '2160p'],
    [/\.1080[pi]\./, 8, '1080p'],
    [/\.720p\./, 4, '720p'],
    [/\.(?:576|480|360)[pi]\./, 1, 'SD']
  ];
  const SOURCES = [
    [/\.remux\./, 8, 'Remux'],
    [/\.bdmv\./, 8, 'BDMV'],
    [/\.4klight\./, 6, '4KLight'],
    [/\.hdlight\./, 6, 'HDLight'],
    [/\.(?:bluray|blu\.ray|bdrip|brrip|bd)\./, 7, 'BluRay'],
    [/\.(?:web\.dl|webdl)\./, 7, 'WEB-DL'],
    [/\.webrip\./, 5, 'WEBRip'],
    [/\.(?:hdtv|pdtv|tvrip|hdrip)\./, 3, 'HDTV'],
    [/\.dvdrip\./, 2, 'DVDRip'],
    [/\.(?:cam|camrip|hdcam|telesync|ts|tc)\./, 0, 'CAM'],
    [/\.web\./, 7, 'WEB']
  ];
  const HDRS = [
    [/\.(?:dv|dovi|dolby\.vision)\./, 4, 'DV'],
    [/\.hdr10plus\./, 4, 'HDR10+'],
    [/\.hdr10\./, 3, 'HDR10'],
    [/\.(?:hdr|hlg)\./, 3, 'HDR'],
    [/\.sdr\./, 0, 'SDR']
  ];
  const AUDIOS = [
    [/\.truehd\./, 4, 'TrueHD'],
    [/\.atmos\./, 4, 'Atmos'],
    [/\.(?:dts\.hd|dtshd)\./, 4, 'DTS-HD'],
    [/\.(?:dts\.x|dtsx)\./, 4, 'DTS:X'],
    [/\.flac\./, 4, 'FLAC'],
    [/\.(?:eac3|ddp)\d*\./, 3, 'EAC3'],
    [/\.dts\d*\./, 3, 'DTS'],
    [/\.(?:ac3|dd)\d*\./, 2, 'AC3'],
    [/\.aac\d*\./, 2, 'AAC'],
    [/\.opus\d*\./, 2, 'Opus'],
    [/\.mp3\./, 1, 'MP3']
  ];
  const CODECS = [
    [/\.av1\./, 1.5, 'AV1'],
    [/\.(?:x265|h\.?265|hevc)\./, 2, 'H.265'],
    [/\.(?:x264|h\.?264|avc)\./, 1, 'H.264'],
    [/\.(?:xvid|divx|mpeg2|vc1)\./, 0, 'XviD']
  ];

  const matches = (f, table) => table.filter(([re]) => re.test(f));
  const firstOf = (f, table) => {
    const hit = matches(f, table)[0];
    return hit ? { label: hit[2], pts: hit[1] } : null;
  };
  const bestOf = (f, table) => {
    const hits = matches(f, table);
    if (!hits.length) return null;
    const top = hits.reduce((a, b) => (b[1] > a[1] ? b : a));
    return { label: top[2], pts: top[1] };
  };

  function parseSize(text) {
    const m = /^(\d+(?:[.,]\d+)?)\s*([kmgt])i?[bo]$/i.exec(String(text || '').trim());
    if (!m) return null;
    const unit = { k: 1 / 1048576, m: 1 / 1024, g: 1, t: 1024 }[m[2].toLowerCase()];
    return parseFloat(m[1].replace(',', '.')) * unit;
  }

  // Null unless a resolution or a source is recognised: music and other non-video torrents get no score.
  function parseRelease(text) {
    const f = flat(text);
    const res = firstOf(f, RESOLUTIONS);
    const src = firstOf(f, SOURCES);
    if (!res && !src) return null;
    const hdrHits = matches(f, HDRS);
    return {
      lang: firstOf(f, LANGS),
      res,
      src,
      hdr: hdrHits.length
        ? { label: hdrHits.map((h) => h[2]).join('.'), pts: Math.max(...hdrHits.map((h) => h[1])) } : null,
      audio: bestOf(f, AUDIOS),
      codec: bestOf(f, CODECS)
    };
  }

  const GROUP_LABEL = /^(?:pure|hcopt|opti|compat)-/i;

  // The cells of one row (versions list or results grid), as texts. `hints.seeders` comes from the caller.
  function parseCells(texts, hints) {
    let sizeGB = null;
    const rest = [];
    for (const text of texts) {
      const size = parseSize(text);
      if (size !== null) { if (sizeGB === null) sizeGB = size; continue; }
      if (text !== '·' && !GROUP_LABEL.test(text)) rest.push(text);
    }
    const release = parseRelease(rest.join(' '));
    if (!release) return null;
    const seeders = hints && typeof hints.seeders === 'number' ? hints.seeders : null;
    return { release, sizeGB, seeders };
  }

  const TECH_TOKEN = new RegExp('^(?:multi|vff|vof|truefrench|vf2|vfi|vfq|vf|french|vostfr|subfrench|vost|vo'
    + '|2160p|1080[pi]|720p|(?:576|480|360)[pi]|4k|uhd|remux|bdmv|4klight|hdlight|bluray|blu|bdrip|brrip|bd'
    + '|web|webdl|webrip|hdtv|dvdrip|cam|ts|tc|av1|x265|h265|hevc|x264|h264|avc|xvid|divx'
    + '|dv|dovi|hdr|hdr10|hdr10plus|hlg|sdr)$');
  const SEASON_TOKEN = /^s\d{1,2}(?:e\d{1,3})*$/;
  const YEAR_TOKEN = /^(?:19|20)\d\d$/;

  // Identifies the film (or the season) a release name is about, so that only its own versions are compared.
  function titleKey(name) {
    const tokens = flat(name).split('.').filter(Boolean);
    const cut = tokens.findIndex((t) => TECH_TOKEN.test(t) || SEASON_TOKEN.test(t));
    const region = cut === -1 ? tokens : tokens.slice(0, cut);
    if (!region.length) return '';
    const season = tokens.find((t) => SEASON_TOKEN.test(t));
    if (season) {
      if (region.length > 1 && YEAR_TOKEN.test(region[region.length - 1])) region.pop();
      return region.join('') + season;
    }
    for (let i = region.length - 1; i > 0; i--) if (YEAR_TOKEN.test(region[i])) return region.slice(0, i + 1).join('');
    return region.join('');
  }

  function qualityFraction(r) {
    let got = r.hdr ? r.hdr.pts : 0;
    let max = QUALITY_MAX.hdr;
    for (const k of ['res', 'src', 'audio', 'codec']) {
      if (r[k]) { got += r[k].pts; max += QUALITY_MAX[k]; }
    }
    return got / max;
  }

  const langPoints = (r) => (r.lang ? r.lang.pts : LANG_UNKNOWN);

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  const AWARDS = {
    best: { glyph: '★', label: 'Meilleur choix', color: '#facc15' },
    value: { glyph: '⚖\uFE0E', label: 'Meilleur rapport qualité/taille', color: '#60a5fa' },
    quality: { glyph: '◆', label: 'Meilleure qualité', color: '#c084fc' },
    seeds: { glyph: '⚡\uFE0E', label: 'Plus de seeders', color: '#4ade80' }
  };

  const bandColor = (score) => (score >= 80 ? '#22c55e' : score >= 65 ? '#84cc16' : score >= 50 ? '#f59e0b' : '#ef4444');

  // The weights of the settings when they are usable (each a number from 0 to 100, one at least above 0), else null.
  function cleanWeights(w) {
    if (!w || typeof w !== 'object') return null;
    const out = {};
    for (const k of Object.keys(WEIGHTS)) {
      if (typeof w[k] !== 'number' || !isFinite(w[k])) return null;
      out[k] = Math.min(100, Math.max(0, w[k]));
    }
    return Object.keys(out).some((k) => out[k] > 0) ? out : null;
  }

  // Scores the torrents of one film against each other. entries: [{ release, sizeGB, seeders }] (null = unknown).
  // Seeders and sizes only count when they are known for every entry, so that the scores stay comparable.
  // wanted: the { lang, quality, health, size } weights of the settings; the default ones apply when absent or unusable.
  function scoreGroup(entries, wanted) {
    const n = entries.length;
    const known = (v) => typeof v === 'number' && isFinite(v);
    const useHealth = n > 0 && entries.every((e) => known(e.seeders));
    const sized = n >= 2 && entries.every((e) => known(e.sizeGB) && e.sizeGB > 0);
    const qualities = entries.map((e) => qualityFraction(e.release));
    const ratios = sized
      ? entries.map((e, i) => Math.pow(qualities[i], QUALITY_EXP) / Math.pow(e.sizeGB, SIZE_EXP)) : [];
    const mid = sized ? median(ratios) : 0;
    const useSize = sized && mid > 0;

    // Only the parts that can be computed count. If the settings give them no weight at all, the default weights apply.
    const weightsOf = (w) => {
      const out = { lang: w.lang, quality: w.quality };
      if (useHealth) out.health = w.health;
      if (useSize) out.size = w.size;
      return out;
    };
    let weights = weightsOf(cleanWeights(wanted) || WEIGHTS);
    if (!Object.keys(weights).some((k) => weights[k] > 0)) weights = weightsOf(WEIGHTS);
    const total = Object.keys(weights).reduce((t, k) => t + weights[k], 0);
    const max = {};
    for (const k of Object.keys(weights)) max[k] = 100 * weights[k] / total;

    const rows = entries.map((e, i) => {
      const frac = { lang: langPoints(e.release) / LANG_MAX, quality: qualities[i] };
      if (useHealth) frac.health = Math.min(1, Math.log10(1 + Math.max(0, e.seeders)) / Math.log10(101));
      if (useSize) frac.size = 0.5 + 0.5 * Math.tanh(Math.log(ratios[i] / mid) / Math.LN2);
      const parts = {};
      let sum = 0;
      for (const k of Object.keys(frac)) { parts[k] = frac[k] * max[k]; sum += parts[k]; }
      const dead = e.seeders === 0;
      return {
        score: Math.min(Math.round(sum), dead ? DEAD_CAP : 100),
        parts,
        dead,
        lang: langPoints(e.release),
        quality: qualities[i],
        ratio: ratios[i] || 0,
        awards: []
      };
    });

    if (n >= 2) {
      const by = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      const seeds = (i) => (known(entries[i].seeders) ? entries[i].seeders : -1);
      const size = (i) => (known(entries[i].sizeGB) && entries[i].sizeGB > 0 ? entries[i].sizeGB : Infinity);
      const alive = rows.map((r, i) => i).filter((i) => !rows[i].dead);
      const winner = (ids, cmp) => (ids.length ? ids.slice().sort((a, b) => cmp(a, b) || a - b)[0] : -1);
      const give = (i, key) => { if (i >= 0) rows[i].awards.push(key); };

      give(winner(alive, (a, b) => by(rows[b].score, rows[a].score) || by(seeds(b), seeds(a)) || by(size(a), size(b))), 'best');
      if (useSize) {
        const topLang = Math.max(...alive.map((i) => rows[i].lang));
        const topQuality = Math.max(...alive.map((i) => rows[i].quality));
        const candidates = alive.filter((i) => rows[i].lang >= 0.8 * topLang && rows[i].quality >= 0.85 * topQuality);
        give(winner(candidates, (a, b) => by(rows[b].ratio, rows[a].ratio) || by(rows[b].score, rows[a].score) || by(size(a), size(b))), 'value');
      }
      give(winner(alive, (a, b) => by(rows[b].quality, rows[a].quality) || by(rows[b].lang, rows[a].lang)
        || by(seeds(b), seeds(a)) || by(size(a), size(b))), 'quality');
      if (useHealth) {
        const top = Math.max(...alive.map(seeds));
        const leaders = alive.filter((i) => seeds(i) === top);
        if (top > 0 && leaders.length === 1) give(leaders[0], 'seeds');
      }
    }
    return { rows, useHealth, useSize, max };
  }

  const describe = (r) => ['lang', 'res', 'src', 'hdr', 'audio', 'codec'].map((k) => r[k] && r[k].label).filter(Boolean).join(' · ');

  // Multi-line French text: shown as the tooltip of a badge and in the toast of its click.
  // group.profile (set by the caller) names the settings' profile when it is not the default one.
  function explain(entry, row, group) {
    const names = { lang: 'Langue', quality: 'Qualité', size: 'Qualité/taille', health: 'Seeders' };
    const lines = [`Score ${row.score}/100`];
    for (const k of row.awards) lines.push(`${AWARDS[k].glyph} ${AWARDS[k].label}`);
    lines.push(['lang', 'quality', 'size', 'health'].filter((k) => row.parts[k] !== undefined && group.max[k] > 0)
      .map((k) => `${names[k]} ${Math.round(100 * row.parts[k] / group.max[k])} %`).join(' · '));
    lines.push(describe(entry.release));
    if (row.dead) lines.push(`0 seeder : score plafonné à ${DEAD_CAP}, jamais recommandé.`);
    else if (typeof entry.seeders !== 'number') lines.push('Seeders inconnus : non comptés.');
    else if (!group.useHealth) lines.push(`Seeders : ${entry.seeders} (non comptés : inconnus pour les autres versions).`);
    if (group.profile) lines.push(`Profil : ${group.profile}`);
    return lines.join('\n');
  }
  // ==== scoring:end ====

  // ---------- Scoring profile: the weights chosen in the settings ----------

  // ==== profile:begin ====
  // The presets other than the default one, named as in the settings (same ids and labels in the apps).
  const PROFILE_LABELS = {
    qualite: 'Qualité d’image',
    vf: 'VF / MULTI d’abord',
    leger: 'Petite taille',
    ratio: 'Ratio (seeders)',
    perso: 'Personnalisé'
  };
  // The default weights apply until the engine has answered, and whenever it can't.
  let profile = { preset: 'equilibre', weights: Object.assign({}, WEIGHTS) };
  let scoringStarted = false;

  function scoreWithProfile(entries) {
    const group = scoreGroup(entries, profile.weights);
    if (profile.preset !== 'equilibre') group.profile = PROFILE_LABELS[profile.preset];
    return group;
  }

  // Asks the engine for the settings. An answer that is missing or unusable keeps what is already known.
  async function loadProfile() {
    try {
      const res = await send({ type: 'pagePrefs' });
      const score = res && res.ok && res.score;
      const weights = score && cleanWeights(score.weights);
      if (!weights) return;
      const known = score.preset === 'equilibre' || Object.prototype.hasOwnProperty.call(PROFILE_LABELS, score.preset);
      const preset = known ? score.preset : 'perso';
      if (preset === profile.preset && JSON.stringify(weights) === JSON.stringify(profile.weights)) return;
      profile = { preset, weights };
      if (scoringStarted) refreshScores();
    } catch (e) {
      console.warn('Arr411 : réglages du score indisponibles', e);
    }
  }
  // ==== profile:end ====

  // ---------- Scoring badges: torrent page and lists ----------

  const GLYPH_ORDER = ['best', 'value', 'quality', 'seeds'];
  const MAX_GLYPHS = 2;
  const chipSig = new WeakMap();

  const isOurs = (el) => el.hasAttribute(SCORE) || el.hasAttribute(PILL) || el.hasAttribute(MARK);
  const toInt = (text) => (/^\d+(?:[\s\u00a0\u202f.,]\d{3})*$/.test(text) ? Number(text.replace(/\D+/g, '')) : null);
  const hashOf = (a) => {
    const m = /\/torrents\/([a-f0-9]{40})\b/i.exec(a.getAttribute('href') || '');
    return m ? m[1].toLowerCase() : '';
  };

  // A team named like a release tag ("TS", "BD"...) must not change how its row reads.
  const isTeamLink = (el) => el.tagName === 'A' && /\/community\/teams\//.test(el.getAttribute('href') || '');

  // The elements holding text of their own (the cells of a row) with that text. Our injections are skipped.
  function cellsOf(root) {
    const out = [];
    (function walk(el) {
      for (const c of el.children) {
        if (isOurs(c) || isTeamLink(c) || /^(?:svg|script|style)$/i.test(c.tagName)) continue;
        let own = '';
        for (const n of c.childNodes) if (n.nodeType === 3) own += n.nodeValue;
        own = own.replace(/\s+/g, ' ').trim();
        if (own) out.push({ el: c, text: own });
        walk(c);
      }
    })(root);
    return out;
  }

  // The seeders of a results row are its one green number.
  function listHints(cells) {
    const green = cells.filter((c) => /text-green/.test(String(c.el.className)) && toInt(c.text) !== null);
    return { seeders: green.length === 1 ? toInt(green[0].text) : null };
  }

  function styled(text, css) {
    const el = document.createElement('span');
    el.textContent = text;
    Object.assign(el.style, css);
    return el;
  }

  function newChip(kind) {
    const chip = document.createElement('span');
    chip.setAttribute(SCORE, kind);
    Object.assign(chip.style, {
      display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '1px 7px', borderRadius: '999px',
      font: '600 11px/1.5 system-ui, sans-serif', whiteSpace: 'nowrap', flexShrink: '0', cursor: 'pointer'
    });
    if (kind === 'cell') Object.assign(chip.style, { justifySelf: 'center', alignSelf: 'center' });
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toast(chip.title, false, true);
    });
    return chip;
  }

  // Looks like the stats cards of the torrent page: their classes are copied.
  function newCard(sample) {
    const card = document.createElement(sample.tagName.toLowerCase());
    card.className = sample.className;
    card.setAttribute(SCORE, 'page');
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => toast(card.title, false, true));
    return card;
  }

  // True when the element already shows this content: it is then left alone, so no mutation is triggered.
  function unchanged(el, sig) {
    if (chipSig.get(el) === sig) return true;
    chipSig.set(el, sig);
    return false;
  }

  const awardsOf = (scored) => GLYPH_ORDER.filter((k) => scored.awards.indexOf(k) !== -1);

  function paintChip(chip, entry, scored, group) {
    const glyphs = awardsOf(scored).slice(0, MAX_GLYPHS);
    const tip = explain(entry, scored, group);
    if (unchanged(chip, [scored.score, glyphs.join(), tip].join('|'))) return;
    const color = bandColor(scored.score);
    chip.title = tip;
    Object.assign(chip.style, { background: color + '26', color, border: `1px solid ${color}66` });
    chip.replaceChildren(String(scored.score), ...glyphs.map((k) => styled(AWARDS[k].glyph, { color: AWARDS[k].color })));
  }

  function paintCard(card, entry, scored, group) {
    const awards = awardsOf(scored);
    const tip = explain(entry, scored, group);
    if (unchanged(card, [scored.score, awards.join(), tip].join('|'))) return;
    const dim = { fontSize: '12px', opacity: '.65' };
    card.title = tip;
    card.replaceChildren(
      styled('Score', dim),
      styled(String(scored.score), { fontSize: '14px', fontWeight: '700', color: bandColor(scored.score) }),
      styled('/100', dim),
      ...awards.map((k) => styled(`${AWARDS[k].glyph} ${AWARDS[k].label}`,
        { fontSize: '12px', fontWeight: '600', color: AWARDS[k].color, whiteSpace: 'nowrap' }))
    );
  }

  // The stats cards under the torrent title (size, seeders, ...). Null when they can't be found.
  function pageStats() {
    const label = [...document.querySelectorAll('span')].find((s) => !s.children.length && /^seeders?$/i.test(norm(s))
      && !!s.previousElementSibling && toInt(norm(s.previousElementSibling)) !== null);
    const sample = label && label.parentElement;
    const box = sample && sample.parentElement;
    if (!box) return null;
    let sizeGB = null;
    for (const card of box.children) {
      const size = isOurs(card) ? null : parseSize(norm(card));
      if (size !== null) { sizeGB = size; break; }
    }
    return { seeders: toInt(norm(label.previousElementSibling)), sizeGB, box, sample };
  }

  // The children of the container linking to the most torrents that read as releases:
  // [{ el, entry, cells, hash }]. hash is empty for the row of the torrent being viewed (it is no link).
  function linkedRows(scope) {
    const parents = new Set();
    for (const a of scope.querySelectorAll('a[href*="/torrents/"]')) if (hashOf(a) && a.parentElement) parents.add(a.parentElement);
    let best = [];
    for (const parent of parents) {
      const rows = [];
      for (const el of parent.children) {
        const hash = el.tagName === 'A' ? hashOf(el) : '';
        if (isOurs(el) || (!hash && el.tagName !== 'DIV') || el.querySelector('[class*="grid-cols-["]')) continue;
        const cells = cellsOf(el);
        const entry = cells.length >= 5 ? parseCells(cells.map((c) => c.text), null) : null;
        if (entry && entry.sizeGB > 0) rows.push({ el, entry, cells, hash });
      }
      if (rows.length > best.length) best = rows;
    }
    return best;
  }

  // "Versions (+33)": the other releases of the film, listed on its page.
  function versionRows() {
    const toggle = [...document.querySelectorAll('button')].find((b) => /^Versions\b/.test(norm(b)));
    let scope = toggle ? toggle.parentElement : null;
    for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
      const rows = linkedRows(scope);
      if (rows.length) return rows;
    }
    return [];
  }

  function paintVersion(row, entry, scored, group, live) {
    const sizeCell = row.cells.find((c) => parseSize(c.text) !== null);
    if (!sizeCell) return;
    let chip = row.el.querySelector(`[${SCORE}]`);
    if (!chip) chip = newChip('row');
    if (chip.nextElementSibling !== sizeCell.el) sizeCell.el.insertAdjacentElement('beforebegin', chip);
    paintChip(chip, entry, scored, group);
    live.add(chip);
  }

  // The card goes with the stats of the torrent, else it follows the qBittorrent button.
  function paintPage(stats, entry, scored, group, live) {
    const kind = stats ? 'page' : 'page-inline';
    let el = document.querySelector(`[${SCORE}^="page"]`);
    if (el && el.getAttribute(SCORE) !== kind) { el.remove(); el = null; }
    if (stats) {
      if (!el) el = newCard(stats.sample);
      if (stats.box.lastElementChild !== el) stats.box.append(el);
      paintCard(el, entry, scored, group);
    } else {
      const after = badge && badge.isConnected ? badge : document.querySelector(`button[${MARK}="ours"]`);
      if (!after) return;
      if (!el) el = newChip(kind);
      if (after.nextElementSibling !== el) after.insertAdjacentElement('afterend', el);
      paintChip(el, entry, scored, group);
    }
    live.add(el);
  }

  function scorePage(live) {
    const h1 = document.querySelector('h1');
    const release = h1 ? parseRelease(h1.textContent) : null;
    const stats = pageStats();
    const rows = versionRows();
    const pageHash = pageHashFromUrl();
    let at = rows.findIndex((r) => r.hash === pageHash);
    if (at < 0) at = rows.findIndex((r) => !r.hash);
    if (!release && at < 0) return;
    const seeders = stats ? stats.seeders : null;
    const entries = rows.map((r) => r.entry);
    if (at >= 0) entries[at] = Object.assign({}, entries[at], { seeders });
    else { entries.push({ release, sizeGB: stats ? stats.sizeGB : null, seeders }); at = entries.length - 1; }
    const group = scoreWithProfile(entries);
    rows.forEach((r, i) => paintVersion(r, entries[i], group.rows[i], group, live));
    paintPage(stats, entries[at], group.rows[at], group, live);
  }

  // Adds the score column of a results grid. False when its template can't take one.
  function addScoreColumn(token) {
    if (!scoredGrids.has(token)) {
      scoredGrids.add(token);
      applyGridRules();
    }
    return !!gridRule(token);
  }

  // The release name an item shows outside of its columns: it tells which film the row is about.
  function releaseName(link, row) {
    const names = [link.title, link.getAttribute('aria-label')]
      .concat(cellsOf(link).filter((c) => !row.contains(c.el)).map((c) => c.text));
    return names.find((t) => t && parseRelease(t) && titleKey(t)) || '';
  }

  function paintListItem(item, scored, group, live) {
    if (addScoreColumn(item.token)) {
      let chip = [...item.el.children].find((c) => c.hasAttribute(SCORE));
      if (!chip) chip = newChip('cell');
      if (item.el.lastElementChild !== chip) item.el.append(chip);
      paintChip(chip, item.entry, scored, group);
      live.add(chip);
    }
    // Small screens show another layout of the same item: the badge goes next to its own copy button.
    const slot = item.link && pillSlots(item.link).find((s) => s.where === 'beforebegin' && !item.el.contains(s.ref));
    if (!slot) return;
    let prev = slot.ref.previousElementSibling;
    while (prev && prev.hasAttribute(PILL)) prev = prev.previousElementSibling;
    const chip = prev && prev.hasAttribute(SCORE) ? prev : newChip('card');
    if (chip !== prev) slot.ref.insertAdjacentElement('beforebegin', chip);
    paintChip(chip, item.entry, scored, group);
    live.add(chip);
  }

  // Results grids (search, categories): the rows of one film are compared, the others get a score alone.
  function scoreLists(live) {
    const groups = new Map();
    const batches = [];
    for (const el of document.querySelectorAll('[class*="grid-cols-["]')) {
      const token = gridToken(el);
      if (!token || el.querySelector('h1')) continue;
      const tracks = token.slice('lg:grid-cols-['.length, -1).split('_').length;
      if ([...el.children].filter((c) => !c.hasAttribute(SCORE)).length !== tracks) continue;
      const cells = cellsOf(el);
      const entry = parseCells(cells.map((c) => c.text), listHints(cells));
      if (!entry || !(entry.sizeGB > 0)) continue;
      const link = rowLink(el);
      const key = link ? titleKey(releaseName(link, el)) : '';
      const item = { el, token, entry, link };
      if (!key) batches.push([item]);
      else if (groups.has(key)) groups.get(key).push(item);
      else groups.set(key, [item]);
    }
    for (const items of [...groups.values(), ...batches]) {
      const group = scoreWithProfile(items.map((i) => i.entry));
      items.forEach((item, i) => paintListItem(item, group.rows[i], group, live));
    }
  }

  function refreshScores() {
    try {
      const live = new Set();
      if (pageHashFromUrl()) scorePage(live);
      scoreLists(live);
      for (const el of document.querySelectorAll(`[${SCORE}]`)) if (!live.has(el)) el.remove();
    } catch (e) {
      console.warn('Arr411 : badges de score indisponibles', e);
    }
  }

  let refreshTimer = null;
  let injectTimer = null;
  let injectPending = false;
  const INJECT_WINDOW_MS = 100;

  // The first mutation after a quiet spell is handled at once (our buttons show up in the same frame as the
  // page's rows); the ones that follow within the window are merged into a single scan at its end.
  function scheduleInject() {
    if (injectTimer !== null) { injectPending = true; return; }
    injectPending = false;
    inject();
    injectTimer = setTimeout(() => {
      injectTimer = null;
      if (injectPending) scheduleInject();
    }, INJECT_WINDOW_MS);
  }
  const isOwn = (n) => n.nodeType === 1 && (n.hasAttribute(PILL) || n.hasAttribute(MARK) || n.hasAttribute(SCORE));
  // The removal of one of our buttons (e.g. by a Vue re-render) is a page change: it must be put back.
  const isOwnButton = (n) => n.nodeType === 1 && n.tagName === 'BUTTON' && n.hasAttribute(MARK);
  const isOwnMutation = (m) => (badge && badge.contains(m.target)) || isOwn(m.target)
    || ([...m.addedNodes, ...m.removedNodes].every(isOwn) && ![...m.removedNodes].some(isOwnButton));

  // C411 is rendered by the server, then Vue "hydrates" it: nodes added before that are thrown away or
  // reused by Vue (buttons lost after a reload). page-hook.js flags <html> once hydration is over.
  function whenHydrated(start) {
    const t0 = Date.now();
    (function wait() {
      if (document.documentElement.hasAttribute('data-qbt-hydrated') || Date.now() - t0 > 15000) start();
      else setTimeout(wait, 100);
    })();
  }

  whenHydrated(() => {
    scoringStarted = true;
    new MutationObserver((mutations) => {
      if (mutations.every(isOwnMutation)) return;
      scheduleInject();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refreshStatus(); refreshListBadges(); refreshScores(); }, 600);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => { if (!document.hidden) refreshListBadges(); }, 30000);
    inject();
    refreshStatus();
    refreshListBadges();
    refreshScores();
  });

  // A change of the settings applies when the user comes back to the tab, without reloading the page.
  loadProfile();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadProfile(); });
})();
