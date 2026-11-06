'use strict';
const fs = require('fs');
const path = require('path');
const { scanFolder, parseName } = require('./scanner');
const { probeEntry } = require('./probe');
const { norm } = require('./matcher');
const { renameTitle } = require('./filenames');

const LOST_MIN = 10;
const LOST_SHARE = 0.5;
const idOf = (p) => String(p).toLowerCase();
// Папка «Фильмы2» не считается вложенной в папку «Фильмы».
function inFolder(id, folderId) {
  if (id === folderId) return true;
  const withSep = /[\\/]$/.test(folderId) ? folderId : `${folderId}${path.sep}`;
  return id.startsWith(withSep);
}
const fileKey = (e) => `${norm(e.title)}|${e.size}`;
const nameKey = (t, y) => `${norm(t)}|${y || ''}`;

// Библиотека: у фильма несколько имён, и папка может совпасть с любым.
function buildIndex(state) {
  const idx = new Map();
  const add = (name, f) => {
    const k = norm(name);
    if (!k) return;
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(f.key);
  };
  Object.values(state.films).forEach((f) => {
    [f.userTitle, f.tmdbTitle, f.originalTitle, ...(f.altTitles || [])].forEach((n) => add(n, f));
  });
  return idx;
}

function matchEntry(state, idx, e) {
  const remembered = state.nameLinks && state.nameLinks[nameKey(e.title, e.year)];
  if (remembered && state.films[remembered]) return { key: remembered, how: 'memory' };
  let hits = [...(idx.get(norm(e.title)) || [])].map((k) => state.films[k]);
  if (e.year) {
    const exact = hits.filter((f) => f.year === e.year);
    const close = hits.filter((f) => f.year && Math.abs(f.year - e.year) === 1);
    hits = exact.length ? exact : close;
  }
  if (hits.length === 1) return { key: hits[0].key, how: e.year ? (hits[0].year === e.year ? 'name-year' : 'name-near-year') : 'name' };
  if (hits.length > 1 && e.duration) {
    const near = hits.filter((f) => f.runtime && Math.abs(f.runtime - e.duration) <= 6);
    if (near.length === 1) return { key: near[0].key, how: 'duration' };
  }
  return hits.length > 1 ? { candidates: hits.map((f) => f.key) } : {};
}

// Подмешивается в Service: хранит файлы, связи и задачи.
const diskMethods = {
  folders() { return this.state.folders || (this.state.folders = []); },
  entries() { return this.state.files || (this.state.files = {}); },

  addFolder(p, role = 'normal') {
    const clean = String(p).replace(/[\\/]+$/, '') + (/^[A-Za-z]:$/.test(String(p).replace(/[\\/]+$/, '')) ? '\\' : '');
    if (!this.folders().some((f) => idOf(f.path) === idOf(clean))) this.folders().push({ path: clean, role });
    this.save();
    return this.state;
  },
  removeFolder(p) {
    this.state.folders = this.folders().filter((f) => idOf(f.path) !== idOf(p));
    Object.keys(this.entries()).forEach((k) => { if (inFolder(k, idOf(p))) delete this.entries()[k]; });
    this.refreshTasks();
    this.save();
    return this.state;
  },
  setFolderRole(p, role) {
    this.folders().forEach((f) => {
      if (role === 'today' && f.role === 'today') f.role = 'normal';
      if (idOf(f.path) === idOf(p)) f.role = role;
    });
    this.folders().forEach((f) => { Object.entries(this.entries()).forEach(([k, e]) => { if (inFolder(k, idOf(f.path))) e.role = f.role; }); });
    if (role === 'exclude') Object.keys(this.entries()).forEach((k) => { if (inFolder(k, idOf(p))) delete this.entries()[k]; });
    this.save();
    return this.state;
  },
  setAllConnected(v) { this.state.allConnected = !!v; this.save(); return this.state; },

  async scanAll(onlyPath) {
    if (this.scanning) return this.state;
    this.scanning = true;
    this.state.scan = { running: true, current: null, found: 0, errors: [], offline: [] };
    const exclude = this.folders().filter((f) => f.role === 'exclude').map((f) => f.path);
    try {
      for (const folder of this.folders()) {
        if (folder.role === 'exclude' || (onlyPath && idOf(folder.path) !== idOf(onlyPath))) continue;
        await this.scanOne(folder, exclude);
      }
      await this.probeAll();
      this.linkAll();
      this.refreshTasks();
    } finally {
      this.state.scan.running = false;
      this.state.scan.at = new Date().toISOString();
      this.scanning = false;
      this.save();
    }
    return this.state;
  },

  async scanOne(folder, exclude) {
    let res;
    try {
      res = await scanFolder(folder.path, { exclude, onProgress: (p) => { this.state.scan.current = p.current; this.state.scan.found = p.found; this.onScan && this.onScan(this.state.scan); } });
    } catch (e) {
      folder.status = 'offline';
      this.state.scan.offline.push(folder.path);
      this.flagLost(folder, this.countIn(folder), 'недоступна');
      return;
    }
    const prefix = idOf(folder.path);
    const prev = Object.entries(this.entries()).filter(([k]) => inFolder(k, prefix));
    const seen = new Set(res.entries.map((e) => idOf(e.path)));
    const missing = prev.filter(([k]) => !seen.has(k));
    if (folder.role !== 'today' && prev.length >= LOST_MIN && missing.length >= prev.length * LOST_SHARE) {
      folder.status = 'suspicious';
      this.flagLost(folder, missing.length, 'пропала большая часть фильмов');
      return;
    }
    this.state.scan.errors.push(...res.errors);
    folder.status = 'ok';
    folder.scannedAt = new Date().toISOString();
    folder.count = res.entries.length;
    delete (this.state.lost || {})[prefix];
    missing.forEach(([k, e]) => { this.graveyard = this.graveyard || new Map(); if (e.filmKey) this.graveyard.set(fileKey(e), e); delete this.entries()[k]; });
    res.entries.forEach((e) => {
      const id = idOf(e.path);
      const old = this.entries()[id];
      const same = old && old.size === e.size && old.mtime === e.mtime;
      this.entries()[id] = same ? { ...old, ...e, duration: old.duration, subs: old.subs, probed: old.probed, filmKey: old.filmKey, state: old.state, candidates: old.candidates, matchMethod: old.matchMethod, forceReview: old.forceReview } : { ...e, id, role: folder.role, probed: false, state: null, renamePreference: old?.renamePreference, customName: old?.customName };
      this.entries()[id].id = id;
      this.entries()[id].role = folder.role;
    });
  },

  countIn(folder) {
    const prefix = idOf(folder.path);
    return Object.keys(this.entries()).filter((k) => inFolder(k, prefix)).length;
  },
  flagLost(folder, count, reason) {
    if (!count) return;
    this.state.lost = this.state.lost || {};
    this.state.lost[idOf(folder.path)] = { path: folder.path, count, reason };
  },

  // Новый путь к той же папке: файлы и оценки сохраняются, связи находятся заново.
  async updateFolderPath(oldPath, newPath) {
    const folder = this.folders().find((f) => idOf(f.path) === idOf(oldPath));
    if (!folder) throw new Error('Папка не найдена.');
    const from = idOf(oldPath);
    const clean = String(newPath).replace(/[\\/]+$/, '') + (/^[A-Za-z]:$/.test(String(newPath).replace(/[\\/]+$/, '')) ? '\\' : '');
    const moved = {};
    Object.entries(this.entries()).forEach(([k, e]) => {
      if (!inFolder(k, from)) { moved[k] = e; return; }
      this.graveyard = this.graveyard || new Map();
      if (e.filmKey) this.graveyard.set(fileKey(e), e);
    });
    this.state.files = moved;
    folder.path = clean;
    delete (this.state.lost || {})[from];
    return this.scanAll(clean);
  },
  // Пользователь подтвердил, что фильмы действительно убраны.
  async confirmLost(p) {
    const prefix = idOf(p);
    Object.keys(this.entries()).forEach((k) => { if (inFolder(k, prefix)) delete this.entries()[k]; });
    delete (this.state.lost || {})[prefix];
    return this.scanAll(p);
  },

  async probeAll() {
    const todo = Object.values(this.entries()).filter((e) => !e.probed && e.kind !== 'series');
    let n = 0;
    for (const e of todo) {
      n += 1;
      this.state.scan.current = `Читаю сведения о файлах: ${n} из ${todo.length}`;
      if (this.onScan) this.onScan(this.state.scan);
      Object.assign(e, await probeEntry(e, this.ffprobePath), { probed: true });
      if (n % 25 === 0) this.save();
    }
  },

  linkAll() {
    const idx = buildIndex(this.state);
    Object.values(this.entries()).forEach((e) => {
      if (e.kind === 'series') { if (!['film'].includes(e.state)) e.state = e.state === 'ignored' ? 'ignored' : 'series'; if (e.state !== 'film') return; }
      if (e.state === 'ignored') return;
      if (e.forceReview) { e.state = 'orphan'; return; }
      if (e.filmKey && this.state.films[e.filmKey]) { e.state = 'linked'; return; }
      const ghost = this.graveyard && this.graveyard.get(fileKey(e));
      if (ghost && this.state.films[ghost.filmKey]) { e.filmKey = ghost.filmKey; e.matchMethod = 'moved'; e.state = 'linked'; return; }
      const m = matchEntry(this.state, idx, e);
      if (m.key) { e.filmKey = m.key; e.matchMethod = m.how; e.state = 'linked'; delete e.candidates; } else { e.state = 'orphan'; e.candidates = m.candidates || null; }
    });
  },

  filmEntries(key) { return Object.values(this.entries()).filter((e) => e.filmKey === key && e.state === 'linked'); },

  // Задача появляется у просмотренного фильма с файлом и закрывается, когда файлов не осталось.
  refreshTasks() {
    const byFilm = new Map();
    Object.values(this.entries()).forEach((e) => { if (e.filmKey && e.state === 'linked') byFilm.set(e.filmKey, (byFilm.get(e.filmKey) || 0) + 1); });
    Object.values(this.state.films).forEach((f) => {
      const done = f.status === 'watched' || f.status === 'dropped';
      f.moveTask = !!(done && !f.keepOnDisk && byFilm.get(f.key));
    });
  },

  linkEntryToFilm(id, filmKey, remember = true) {
    const e = this.entries()[id];
    if (!e) throw new Error('Файл не найден.');
    if (!this.state.films[filmKey]) throw new Error('Фильм не найден.');
    e.filmKey = filmKey;
    e.matchMethod = 'manual';
    delete e.forceReview;
    e.state = 'linked';
    delete e.candidates;
    if (remember) { this.state.nameLinks = this.state.nameLinks || {}; this.state.nameLinks[nameKey(e.title, e.year)] = filmKey; }
    return e;
  },
  chooseEntryFilm(id, filmKey) {
    this.linkEntryToFilm(id, filmKey);
    this.refreshTasks();
    this.save();
    return this.state;
  },
  // Файл на диске, которого нет в списке: добавить или сразу отметить просмотренным.
  async addEntryFilm(id, tmdbId, action = false, options = {}) {
    // Boolean arguments remain compatible with older renderer calls.
    const mode = action === true ? 'watched' : action === false ? 'queue' : action;
    if (!['queue', 'watched', 'disk'].includes(mode)) throw new Error('Неизвестное действие с фильмом.');
    if (!this.entries()[id]) throw new Error('Файл не найден.');
    const watched = mode === 'watched';
    const f = this.state.films[`m${tmdbId}`] || this.ensureFilm(await this.detail(tmdbId), { userTitle: this.entries()[id].title, titleSource: 'disk', status: mode === 'queue' ? 'disk' : mode });
    if (options.near && (mode !== 'queue' || ['watched', 'dropped'].includes(f.status))) throw new Error('Сначала верни фильм в очередь или разреши пересмотр.');
    if (mode === 'queue' && (['candidate', 'disk', 'reserve'].includes(f.status) || (options.near && ['nointerest','notfound'].includes(f.status)))) this.enqueueFilm(f, options);
    if (watched) f.status = 'watched';
    if (watched) { f.pending = true; f.watched.push({ date: new Date().toISOString().slice(0, 10), result: 'watched' }); }
    this.linkEntryToFilm(id, f.key);
    if (options.near) this.placeNear(f.key);
    this.rebuildQueues();
    this.linkAll();
    this.refreshTasks();
    if (mode !== 'disk') this.afterQueueChange(f.dir);
    // Разбор старых фильмов не должен заваливать вопросами о режиссёрах, которых нет в списке.
    const d = this.state.directors[f.dir];
    if (watched && d && Object.values(this.state.films).filter((x) => x.dir === f.dir).length === 1) d.needsChoice = false;
    this.save();
    return this.state;
  },
  unlinkEntry(id) {
    const e = this.entries()[id];
    if (!e) throw new Error('Файл не найден.');
    const key = nameKey(e.title, e.year);
    if (this.state.nameLinks && this.state.nameLinks[key] === e.filmKey) delete this.state.nameLinks[key];
    delete e.filmKey;
    delete e.matchMethod;
    delete e.candidates;
    e.forceReview = true;
    e.state = 'orphan';
    this.refreshTasks();
    this.save();
    return this.state;
  },
  ignoreEntry(id) { this.entries()[id].state = 'ignored'; this.save(); return this.state; },
  unignoreEntry(id) { const e = this.entries()[id]; e.state = null; this.linkAll(); this.refreshTasks(); this.save(); return this.state; },
  entryIsFilm(id) { const e = this.entries()[id]; e.state = 'film'; e.kind = e.kind === 'series' ? 'folder' : e.kind; this.linkAll(); this.save(); return this.state; },
  excludeSeriesFolder(p) { this.addFolder(p, 'exclude'); Object.keys(this.entries()).forEach((k) => { if (inFolder(k, idOf(p))) delete this.entries()[k]; }); this.save(); return this.state; },
  keepOnDisk(key) { const f = this.mustFilm(key); f.keepOnDisk = true; f.moveTask = false; this.save(); return this.state; },
  duplicateOk(key) { this.mustFilm(key).dupOk = true; this.save(); return this.state; },

  duplicates() {
    const out = [];
    const byFilm = new Map();
    Object.values(this.entries()).forEach((e) => { if (e.filmKey && e.state === 'linked') { if (!byFilm.has(e.filmKey)) byFilm.set(e.filmKey, []); byFilm.get(e.filmKey).push(e); } });
    byFilm.forEach((list, key) => {
      const f = this.state.films[key];
      if (list.length < 2 || !f || f.dupOk) return;
      const sizes = list.map((e) => e.size);
      out.push({ key, identical: Math.max(...sizes) === Math.min(...sizes), copies: list.map((e) => ({ id: e.id, path: e.path, size: e.size, kind: e.kind, role: e.role })) });
    });
    return out;
  },

  setRenamePreference(id, mode, name = '') {
    const e = this.entries()[id];
    if (!e) throw new Error('Файл не найден.');
    if (!['auto', 'keep', 'custom'].includes(mode)) throw new Error('Неизвестный режим имени.');
    let clean = String(name).trim();
    if (mode === 'custom') {
      const ext = e.kind === 'file' ? path.extname(e.path) : '';
      if (ext && clean.toLowerCase().endsWith(ext.toLowerCase())) clean = clean.slice(0, -ext.length);
      if (!clean || /[<>:"/\\|?*\x00-\x1f]/.test(clean) || /[. ]$/.test(clean) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) || clean.length > 180) throw new Error('Введи допустимое имя Windows без пути; расширение сохраняется отдельно.');
    }
    e.renamePreference = mode;
    e.customName = mode === 'custom' ? clean : null;
    this.save(); return this.state;
  },

  renamePlan() {
    const plan = [];
    Object.values(this.entries()).forEach((e) => {
      if (e.state !== 'linked' || e.role === 'exclude' || e.renamePreference === 'keep') return;
      const f = this.state.films[e.filmKey];
      if (!f || (!f.year && e.renamePreference !== 'custom')) return;
      const base = renameTitle(f, e);
      if (!base) return;
      const isFile = e.kind === 'file';
      const ext = isFile ? path.extname(e.path) : '';
      const to = e.renamePreference === 'custom' ? `${e.customName}${ext}` : `${base} (${f.year})${ext}`;
      if (to !== path.basename(e.path)) plan.push({
        id: e.id, from: path.basename(e.path), to, dir: path.dirname(e.path), filmKey: f.key, title: base,
        matchMethod: e.matchMethod || 'unknown', fileYear: e.year || null, filmYear: f.year,
        duration: e.duration || null,
        requiresConfirmation: e.renamePreference === 'custom' || base !== e.title || !e.year || e.year !== f.year || !e.matchMethod || ['name', 'duration', 'moved'].includes(e.matchMethod),
      });
    });
    return plan;
  },
  // Меняется только внешняя папка или сам файл. Содержимое дисков не трогаем.
  async applyRename(ids, confirmedIds = []) {
    const plan = this.renamePlan().filter((p) => ids.includes(p.id));
    const log = this.state.renameLog || (this.state.renameLog = []);
    const failed = [];
    for (const p of plan) {
      const from = path.join(p.dir, p.from);
      const to = path.join(p.dir, p.to);
      try {
        if (p.requiresConfirmation && !confirmedIds.includes(p.id)) throw new Error('Сначала подтверди фильм и год для этой строки.');
        if (fs.existsSync(to)) throw new Error('имя занято');
        await fs.promises.rename(from, to);
        log.push({ from, to, at: new Date().toISOString() });
        const e = this.entries()[p.id];
        delete this.entries()[p.id];
        const nid = idOf(to);
        this.entries()[nid] = { ...e, id: nid, path: to, name: p.to, video: e.video && e.video.startsWith(from) ? to + e.video.slice(from.length) : e.video };
        Object.assign(this.entries()[nid], parseName(p.to, e.kind === 'file'));
      } catch (err) {
        failed.push({ from: p.from, why: err.message });
      }
    }
    this.save();
    return { state: this.state, failed };
  },
  async undoRename(index) {
    const log = this.state.renameLog || [];
    const item = log[index];
    if (!item) return this.state;
    await fs.promises.rename(item.to, item.from);
    log.splice(index, 1);
    this.save();
    return this.scanAll();
  },
};

module.exports = { diskMethods, buildIndex, matchEntry, idOf, nameKey };
