'use strict';

const fs = require('fs');
const path = require('path');
const { norm, yearOf, isConfident, searchFilm, rank } = require('./matcher');

const SHORT_MINUTES = 40;
const QUEUE_MIN = 2;
const QUEUE_MAX = 3;

function countryName(c) {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(c.iso_3166_1) || c.name;
  } catch (e) {
    return c.name;
  }
}

function emptyState() {
  return {
    version: 1,
    job: null, // ход импорта
    films: {},
    directors: {},
    near: [], // [{ key, ids, source }]
    nearUnresolved: [],
    skipped: [],
    settings: {},
  };
}

function filmKey(id) {
  return `m${id}`;
}

function findInFilmography(list, title, year) {
  const yearOfCredit = (c) => parseInt(String(c.release_date || '').slice(0, 4), 10);
  const want = norm(title);
  const named = (c) => [c.title, c.original_title].map(norm).some((n) => n && (n === want || n.includes(want) || want.includes(n)));
  const sameYear = list.filter((c) => yearOfCredit(c) === year);
  const byName = sameYear.filter(named);
  if (byName.length === 1) return byName[0];
  if (sameYear.length === 1) return sameYear[0];
  const close = list.filter((c) => Math.abs(yearOfCredit(c) - year) === 1 && named(c));
  return close.length === 1 ? close[0] : null;
}

class Service {
  constructor({ dir, tmdb = null, onProgress = () => {} }) {
    this.dir = dir;
    this.file = path.join(dir, 'movie-night.json');
    this.tmdb = tmdb;
    this.onProgress = onProgress;
    this.state = emptyState();
    this.running = false;
    this.stopRequested = false;
    this.details = new Map();
    this.load();
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of [this.file, `${this.file}.bak`]) {
      if (!fs.existsSync(f)) continue;
      try {
        this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(f, 'utf8')) };
        return;
      } catch (e) {
        // Повреждённый файл: пробуем резервную копию.
      }
    }
  }

  // Атомарная запись: сбой во время сохранения не портит прошлую версию.
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  getState() {
    return this.state;
  }

  loadSeed(seed) {
    if (!seed || !Array.isArray(seed.groups) || !Array.isArray(seed.near)) {
      throw new Error('Это не файл начальных данных Movie Night.');
    }
    const items = [];
    const groups = seed.groups.map((g) => {
      const ids = g.films.map((f) => {
        const it = { id: items.length, row: g.row, title: f.title, year: f.year, link: f.link || null, status: 'new', tmdbId: null, cands: [] };
        items.push(it);
        return it.id;
      });
      return { row: g.row, itemIds: ids };
    });
    this.state = {
      ...emptyState(),
      settings: this.state.settings,
      skipped: seed.skipped || [],
      job: { phase: 'films', cursor: 0, items, groups, near: seed.near, nearCursor: 0, nearItems: [], error: null, startedAt: new Date().toISOString() },
    };
    this.save();
  }

  progress(extra = {}) {
    const job = this.state.job;
    if (!job) return null;
    const count = (s) => job.items.filter((i) => i.status === s).length;
    const p = {
      phase: job.phase,
      done: job.phase === 'films' ? job.cursor : job.items.length,
      total: job.items.length,
      auto: count('auto'),
      review: job.items.filter((i) => i.status === 'review').length + job.nearItems.filter((i) => i.status === 'review').length,
      running: this.running,
      error: job.error,
      ...extra,
    };
    this.onProgress(p);
    return p;
  }

  async detail(id) {
    if (this.details.has(id)) return this.details.get(id);
    const d = await this.tmdb.details(id);
    const crew = (d.credits && d.credits.crew) || [];
    const trRu = ((d.translations && d.translations.translations) || []).find((t) => t.iso_639_1 === 'ru');
    const out = {
      id: d.id,
      title: (trRu && trRu.data && trRu.data.title) || null,
      displayTitle: d.title,
      originalTitle: d.original_title,
      year: yearOf(d),
      runtime: d.runtime || null,
      countries: (d.production_countries || []).map((c) => countryName(c)),
      genres: (d.genres || []).map((g) => g.name),
      genreIds: (d.genres || []).map((g) => g.id),
      overview: d.overview || '',
      poster: d.poster_path || null,
      popularity: d.popularity || 0,
      voteAverage: d.vote_average || 0,
      voteCount: d.vote_count || 0,
      directors: crew.filter((c) => c.job === 'Director').map((c) => ({ id: c.id, name: c.name })),
      altTitles: ((d.alternative_titles && d.alternative_titles.titles) || []).map((t) => t.title),
      released: d.status === 'Released',
    };
    this.details.set(id, out);
    return out;
  }

  stopImport() {
    this.stopRequested = true;
  }

  async runImport() {
    const job = this.state.job;
    if (!job || this.running) return this.progress();
    if (!this.tmdb) throw new Error('Не задан ключ TMDB.');
    this.running = true;
    this.stopRequested = false;
    job.error = null;
    try {
      if (job.phase === 'films') await this.importFilms();
      if (job.phase === 'groups') await this.checkGroups();
      if (job.phase === 'near') await this.importNear();
      if (job.phase === 'near-done') {
        await this.fillMissingDetails();
        this.applyResolved();
        job.phase = this.hasReview() ? 'review' : 'done';
      }
    } catch (e) {
      job.error = { kind: e.kind || 'other', message: e.message };
    } finally {
      this.running = false;
      this.save();
    }
    return this.progress();
  }

  async importFilms() {
    const job = this.state.job;
    while (job.cursor < job.items.length) {
      if (this.stopRequested) return;
      const it = job.items[job.cursor];
      const cands = await searchFilm(this.tmdb, it.title, it.year);
      it.cands = cands;
      if (isConfident(cands, it.year)) {
        it.tmdbId = cands[0].id;
        it.status = 'auto';
      } else {
        it.status = cands.length ? 'unsure' : 'none';
      }
      job.cursor += 1;
      if (job.cursor % 20 === 0) this.save();
      this.progress();
    }
    job.phase = 'groups';
    job.groupCursor = 0;
    this.save();
  }

  // Фильмы одной строки проверяют друг друга: у них должен быть общий режиссёр.
  async checkGroups() {
    const job = this.state.job;
    job.groupCursor = job.groupCursor || 0;
    while (job.groupCursor < job.groups.length) {
      if (this.stopRequested) return;
      const g = job.groups[job.groupCursor];
      await this.checkGroup(g);
      job.groupCursor += 1;
      if (job.groupCursor % 20 === 0) this.save();
      this.progress({ phase: 'groups', done: job.groupCursor, total: job.groups.length });
    }
    job.phase = 'near';
    this.save();
  }

  async checkGroup(g) {
    const items = g.itemIds.map((i) => this.state.job.items[i]);
    const options = [];
    for (const it of items) {
      const ids = it.tmdbId ? [it.tmdbId] : it.cands.slice(0, 3).map((c) => c.id);
      const opts = [];
      for (const id of ids) opts.push(await this.detail(id));
      options.push(opts);
    }
    if (items.length === 1) {
      const it = items[0];
      if (it.status === 'auto') {
        const d = options[0][0];
        it.dirIds = d.directors.map((x) => x.id);
        if (!d.directors.length) { it.status = 'review'; it.why = 'В TMDB у фильма не указан режиссёр'; }
      } else {
        it.status = 'review';
        it.why = it.cands.length ? 'Не уверен, какой это фильм' : 'В TMDB ничего не нашлось';
      }
      return;
    }
    const counts = new Map();
    options.forEach((opts) => {
      const dirs = new Set(opts.flatMap((o) => o.directors.map((d) => d.id)));
      dirs.forEach((d) => counts.set(d, (counts.get(d) || 0) + 1));
    });
    let shared = null;
    let best = 0;
    counts.forEach((n, d) => { if (n > best) { best = n; shared = d; } });
    items.forEach((it, idx) => {
      const pick = shared != null && best >= 2 ? options[idx].find((o) => o.directors.some((d) => d.id === shared)) : null;
      if (pick) {
        it.tmdbId = pick.id;
        it.status = 'auto';
        it.dirIds = [shared];
        it.groupDir = shared;
      } else {
        it.status = 'review';
        it.why = items.length > 1 && best < 2 ? 'У фильмов этой строки нет общего режиссёра' : (it.cands.length ? 'Этот фильм не сходится с режиссёром строки' : 'В TMDB ничего не нашлось');
        it.tmdbId = null;
      }
    });
  }

  async importNear() {
    const job = this.state.job;
    const byTitle = new Map();
    job.items.forEach((it) => {
      const k = norm(it.title);
      if (!byTitle.has(k)) byTitle.set(k, []);
      byTitle.get(k).push(it);
    });
    while (job.nearCursor < job.near.length) {
      if (this.stopRequested) return;
      const n = job.near[job.nearCursor];
      const entry = { key: `n${n.position}`, source: n.source, refs: [] };
      for (const alt of n.alternatives) {
        let hits = byTitle.get(norm(alt.title)) || [];
        if (alt.year) hits = hits.filter((h) => !h.year || h.year === alt.year);
        const resolved = [...new Set(hits.filter((h) => h.tmdbId).map((h) => h.tmdbId))];
        if (resolved.length === 1) {
          entry.refs.push({ tmdbId: resolved[0] });
        } else if (hits.length && !resolved.length) {
          entry.refs.push({ itemId: hits[0].id });
        } else {
          const cands = await searchFilm(this.tmdb, alt.title, alt.year);
          const it = { id: `near${job.nearItems.length}`, title: alt.title, year: alt.year, source: n.source, status: 'review', cands, tmdbId: null, why: resolved.length > 1 ? 'В таблице несколько фильмов с таким названием' : 'Фильма нет в таблице, нужно подтвердить', fromNear: true };
          if (isConfident(cands, alt.year) && !resolved.length) { it.tmdbId = cands[0].id; it.status = 'auto'; }
          job.nearItems.push(it);
          entry.refs.push(it.tmdbId ? { tmdbId: it.tmdbId } : { nearItem: it.id });
        }
      }
      job.nearEntries = job.nearEntries || [];
      job.nearEntries.push(entry);
      job.nearCursor += 1;
      this.progress({ phase: 'near', done: job.nearCursor, total: job.near.length });
    }
    job.phase = 'near-done';
    this.save();
  }

  hasReview() {
    const j = this.state.job;
    return j.items.some((i) => i.status === 'review') || j.nearItems.some((i) => i.status === 'review');
  }

  reviewList() {
    const j = this.state.job;
    if (!j) return [];
    const rows = new Map();
    j.groups.forEach((g) => g.itemIds.forEach((i) => rows.set(i, g)));
    return [...j.items.filter((i) => i.status === 'review').map((i) => ({
      id: i.id, title: i.title, year: i.year, row: i.row, why: i.why, cands: i.cands, link: i.link,
      mates: rows.get(i.id).itemIds.filter((x) => x !== i.id).map((x) => { const m = j.items[x]; return `${m.title}${m.year ? ` (${m.year})` : ''}`; }),
    })), ...j.nearItems.filter((i) => i.status === 'review').map((i) => ({ id: i.id, title: i.title, year: i.year, why: i.why, cands: i.cands, mates: [], source: i.source }))];
  }

  findItem(id) {
    const j = this.state.job;
    return typeof id === 'string' ? j.nearItems.find((i) => i.id === id) : j.items[id];
  }

  async resolveItem(id, tmdbId) {
    const it = this.findItem(id);
    if (!it) throw new Error('Запись не найдена.');
    const d = await this.detail(tmdbId);
    it.tmdbId = tmdbId;
    it.status = 'auto';
    it.dirIds = d.directors.map((x) => x.id);
    await this.resolveMates(it, d);
    this.applyResolved();
    this.finishReviewIfDone();
    this.save();
    return this.reviewList();
  }

  skipItem(id) {
    const it = this.findItem(id);
    it.status = 'skipped';
    this.applyResolved();
    this.finishReviewIfDone();
    this.save();
    return this.reviewList();
  }

  // Сведения для карточки выбора: постер, режиссёр, длительность, описание.
  async candidateInfo(ids) {
    const out = {};
    for (const id of ids) {
      try {
        const d = await this.detail(id);
        out[id] = { poster: d.poster, directors: d.directors.map((x) => x.name), runtime: d.runtime, countries: d.countries, overview: d.overview };
      } catch (e) {
        if (e.kind === 'auth' || e.kind === 'network') throw e;
      }
    }
    return out;
  }

  // Если один фильм строки найден, второй ищем в фильмографии его режиссёра:
  // так находятся фильмы, у которых в TMDB другое или непереведённое название.
  async rescueReview() {
    const j = this.state.job;
    if (!j || !this.tmdb) return { resolved: 0, left: 0 };
    let resolved = 0;
    const credits = new Map();
    const filmsOf = async (dir) => {
      if (!credits.has(dir)) {
        const c = await this.tmdb.credits(dir);
        credits.set(dir, (c.crew || []).filter((x) => x.job === 'Director' && !x.video));
      }
      return credits.get(dir);
    };
    for (const g of j.groups) {
      if (g.itemIds.length < 2) continue;
      const items = g.itemIds.map((i) => j.items[i]);
      if (!items.some((i) => i.status === 'review')) continue;
      for (const anchor of items) {
        const top = anchor.tmdbId ? { id: anchor.tmdbId } : (anchor.cands[0] && anchor.cands[0].score >= 85 ? anchor.cands[0] : null);
        if (!top) continue;
        const det = await this.detail(top.id);
        let done = false;
        for (const dir of det.directors) {
          const list = await filmsOf(dir.id);
          for (const other of items) {
            if (other === anchor || other.status !== 'review' || !other.year) continue;
            const m = findInFilmography(list, other.title, other.year);
            if (!m) continue;
            await this.detail(m.id);
            Object.assign(other, { tmdbId: m.id, status: 'auto', groupDir: dir.id, dirIds: [dir.id], applied: false });
            if (anchor.status === 'review') Object.assign(anchor, { tmdbId: top.id, status: 'auto', groupDir: dir.id, dirIds: [dir.id], applied: false });
            resolved += 1;
            done = true;
          }
          if (done) break;
        }
        if (done && !items.some((i) => i.status === 'review')) break;
      }
      if (this.stopRequested) break;
    }
    this.state.rescueDone = true;
    await this.fillMissingDetails();
    this.applyResolved();
    this.finishReviewIfDone();
    this.save();
    return { resolved, left: this.reviewList().length };
  }

  // Понимает название с годом, ссылку на страницу TMDB и имя режиссёра.
  async searchForReview(query) {
    const q = String(query || '').trim();
    const link = q.match(/themoviedb\.org\/movie\/(\d+)/);
    if (link) {
      const d = await this.detail(Number(link[1]));
      return { cands: [{ id: d.id, title: d.displayTitle, originalTitle: d.originalTitle, year: d.year, score: 100 }], people: [] };
    }
    const m = q.match(/^(.+?)[\s,]*\(?\b((?:18|19|20)\d\d)\)?\s*$/);
    const title = m ? m[1].trim() : q;
    const year = m ? Number(m[2]) : null;
    const cands = await searchFilm(this.tmdb, title, year);
    let people = [];
    try {
      const p = await this.tmdb.searchPerson(title);
      people = (p.results || []).filter((x) => x.known_for_department === 'Directing').slice(0, 3).map((x) => ({ id: x.id, name: x.name }));
    } catch (e) {
      if (e.kind === 'auth' || e.kind === 'network') throw e;
    }
    return { cands, people };
  }

  async directorFilms(personId) {
    const c = await this.tmdb.credits(personId);
    const seen = new Set();
    return (c.crew || []).filter((x) => x.job === 'Director' && !x.video && !seen.has(x.id) && seen.add(x.id))
      .map((x) => ({ id: x.id, title: x.title, originalTitle: x.original_title, year: yearOf(x), score: 0 }))
      .sort((a, b) => (a.year || 9999) - (b.year || 9999));
  }

  // Когда фильм строки подтверждён, остальные фильмы строки ищутся у того же режиссёра.
  async resolveMates(it, d) {
    const j = this.state.job;
    if (typeof it.id === 'string' || !d.directors.length) return;
    const g = j.groups.find((x) => x.itemIds.includes(it.id));
    if (!g) return;
    const others = g.itemIds.map((i) => j.items[i]).filter((o) => o !== it && o.status === 'review');
    if (!others.length) return;
    const dir = d.directors[0];
    const films = await this.directorFilms(dir.id);
    it.groupDir = dir.id;
    for (const o of others) {
      const hit = o.year ? findInFilmography(films.map((f) => ({ id: f.id, title: f.title, original_title: f.originalTitle, release_date: f.year ? `${f.year}-01-01` : '' })), o.title, o.year) : null;
      if (hit) {
        await this.detail(hit.id);
        Object.assign(o, { tmdbId: hit.id, status: 'auto', groupDir: dir.id, dirIds: [dir.id], applied: false });
      } else if (films.length) {
        o.cands = films.slice().sort((x, y) => Math.abs((x.year || 0) - (o.year || 0)) - Math.abs((y.year || 0) - (o.year || 0))).slice(0, 6);
        o.why = `Выбери среди фильмов режиссёра: ${dir.name}`;
      }
    }
  }

  finishReviewIfDone() {
    const j = this.state.job;
    if (j.phase === 'review' && !this.hasReview()) j.phase = 'done';
  }

  ensureDirector(d) {
    const dirs = this.state.directors;
    if (!dirs[d.id]) dirs[d.id] = { id: d.id, name: d.name, fav: false, marked: false, banned: false, needsChoice: false };
    return dirs[d.id];
  }

  ensureFilm(d, extra = {}) {
    const key = filmKey(d.id);
    const films = this.state.films;
    if (!films[key]) {
      films[key] = {
        key, tmdbId: d.id, userTitle: extra.userTitle || null, tmdbTitle: d.title || d.displayTitle || null,
        originalTitle: d.originalTitle, year: d.year, runtime: d.runtime, countries: d.countries, genres: d.genres,
        altTitles: d.altTitles || [], overview: d.overview, poster: d.poster, popularity: d.popularity, voteAverage: d.voteAverage, voteCount: d.voteCount,
        directorIds: d.directors.map((x) => x.id), dir: extra.dir ?? (d.directors[0] ? d.directors[0].id : null),
        kpLink: extra.link || null, status: extra.status || 'queue', rating: null, rewatch: false, pending: false, wish: false, watched: [],
      };
    }
    if (extra.link && !films[key].kpLink) films[key].kpLink = extra.link;
    if (extra.userTitle && !films[key].userTitle) films[key].userTitle = extra.userTitle;
    d.directors.forEach((x) => this.ensureDirector(x));
    return films[key];
  }

  // Переносит подтверждённые записи в библиотеку. Безопасно вызывать повторно.
  applyResolved() {
    const j = this.state.job;
    for (const g of j.groups) {
      for (const i of g.itemIds) {
        const it = j.items[i];
        if (it.status === 'auto' && it.tmdbId && !it.applied) {
          const d = this.details.get(it.tmdbId);
          if (!d) { it.needsDetail = true; continue; }
          this.ensureFilm(d, { dir: it.groupDir ?? (d.directors[0] && d.directors[0].id), userTitle: it.title, link: it.link });
          it.applied = true;
        }
      }
    }
    for (const it of j.nearItems) {
      if (it.status === 'auto' && it.tmdbId && !it.applied) {
        const d = this.details.get(it.tmdbId);
        if (d) { this.ensureFilm(d, { userTitle: it.title }); it.applied = true; }
      }
    }
    this.rebuildQueues();
    this.rebuildNear();
  }

  async fillMissingDetails() {
    const j = this.state.job;
    const all = [...j.items, ...j.nearItems].filter((i) => i.status === 'auto' && i.tmdbId && !i.applied);
    for (const it of all) await this.detail(it.tmdbId);
  }

  rebuildNear() {
    const j = this.state.job;
    const entries = (j.nearEntries || []).map((e) => {
      const ids = [];
      e.refs.forEach((r) => {
        let tid = r.tmdbId;
        if (r.itemId != null) tid = j.items[r.itemId].tmdbId;
        if (r.nearItem) tid = j.nearItems.find((x) => x.id === r.nearItem).tmdbId;
        if (tid && !ids.includes(filmKey(tid)) && this.state.films[filmKey(tid)]) ids.push(filmKey(tid));
      });
      return { key: e.key, source: e.source, ids };
    }).filter((e) => e.ids.length);
    const removed = new Set(this.state.nearRemoved || []);
    const existing = new Map(this.state.near.map((e) => [e.key, e]));
    const merged = this.state.near.filter((e) => !removed.has(e.key)).map((e) => {
      const fresh = entries.find((x) => x.key === e.key);
      return fresh ? { ...e, ids: fresh.ids } : e;
    });
    entries.forEach((e) => { if (!existing.has(e.key) && !removed.has(e.key)) merged.push(e); });
    if (!this.state.nearTouched) merged.sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
    this.state.near = merged;
  }

  rebuildQueues() {
    const byDir = new Map();
    Object.values(this.state.films).forEach((f) => {
      if (f.status !== 'queue' && f.status !== 'reserve') return;
      if (!byDir.has(f.dir)) byDir.set(f.dir, []);
      byDir.get(f.dir).push(f);
    });
    byDir.forEach((list) => {
      const nearIds = new Set(this.state.near.flatMap((e) => e.ids));
      list.sort((a, b) => (nearIds.has(b.key) ? 1 : 0) - (nearIds.has(a.key) ? 1 : 0));
      list.forEach((f, i) => { f.status = i < QUEUE_MAX ? 'queue' : 'reserve'; });
    });
  }

  queueCount(dir) {
    return Object.values(this.state.films).filter((f) => f.dir === dir && f.status === 'queue').length;
  }

  afterQueueChange(dir) {
    if (dir == null) return;
    const films = Object.values(this.state.films).filter((f) => f.dir === dir);
    films.filter((f) => f.status === 'reserve').forEach((f) => { if (this.queueCount(dir) < QUEUE_MAX) f.status = 'queue'; });
    const d = this.state.directors[dir];
    if (d) d.needsChoice = this.queueCount(dir) < QUEUE_MIN && !d.banned;
  }

  // ---- Действия пользователя ----
  setFilmStatus(key, status) {
    const f = this.mustFilm(key);
    f.status = status;
    if (status === 'watched' || status === 'dropped') {
      f.pending = true;
      f.watched.push({ date: new Date().toISOString().slice(0, 10), result: status });
    } else {
      f.pending = false;
    }
    this.dropNear(key);
    this.afterQueueChange(f.dir);
    if (this.refreshTasks) this.refreshTasks();
    this.save();
    return { state: this.state, askDirector: this.state.directors[f.dir] && this.state.directors[f.dir].needsChoice ? f.dir : null };
  }

  // Запоминает удалённые строки, чтобы разбор спорных фильмов не вернул их в список.
  dropNear(key) {
    const gone = this.state.near.filter((e) => e.ids.includes(key)).map((e) => e.key);
    this.state.nearRemoved = [...(this.state.nearRemoved || []), ...gone];
    this.state.near = this.state.near.filter((e) => !e.ids.includes(key));
  }

  mustFilm(key) {
    const f = this.state.films[key];
    if (!f) throw new Error('Фильм не найден.');
    return f;
  }

  rate(key, rating) { this.mustFilm(key).rating = rating; this.save(); return this.state; }
  toggleRewatch(key) { const f = this.mustFilm(key); f.rewatch = !f.rewatch; this.save(); return this.state; }
  finishReview(key) { this.mustFilm(key).pending = false; this.save(); return this.state; }
  setTitle(key, title) { this.mustFilm(key).userTitle = String(title || '').trim() || null; this.save(); return this.state; }
  toggleFav(id) { const d = this.state.directors[id]; d.fav = !d.fav; this.save(); return this.state; }
  ban(id) { const d = this.state.directors[id]; d.banned = true; d.needsChoice = false; this.save(); return this.state; }

  addNear(key) {
    this.mustFilm(key);
    if (!this.state.near.some((e) => e.ids.includes(key))) this.state.near.push({ key: `u${Date.now()}`, ids: [key], source: null });
    this.state.nearTouched = true;
    this.save();
    return this.state;
  }

  removeNear(key) {
    this.dropNear(key);
    this.state.nearTouched = true;
    this.save();
    return this.state;
  }

  moveNear(entryKey, toIndex) {
    const a = this.state.near;
    const from = a.findIndex((e) => e.key === entryKey);
    if (from < 0) return this.state;
    const [x] = a.splice(from, 1);
    a.splice(Math.max(0, Math.min(a.length, toIndex)), 0, x);
    this.state.nearTouched = true;
    this.save();
    return this.state;
  }

  // Только полнометражные работы, где человек указан режиссёром.
  async filmography(dirId) {
    const d = this.state.directors[dirId];
    if (!d) throw new Error('Режиссёр не найден.');
    if (!d.filmographyLoaded) {
      const credits = await this.tmdb.credits(dirId);
      const today = new Date().toISOString().slice(0, 10);
      const list = (credits.crew || []).filter((c) => c.job === 'Director' && !c.video && !c.adult && c.release_date && c.release_date <= today);
      const seen = new Set();
      for (const c of list) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const key = filmKey(c.id);
        if (this.state.films[key]) continue;
        const det = await this.detail(c.id);
        if (det.runtime && det.runtime < SHORT_MINUTES) continue;
        this.ensureFilm(det, { dir: dirId, status: 'candidate' });
      }
      d.filmographyLoaded = true;
      this.save();
    }
    return Object.values(this.state.films).filter((f) => f.dir === dirId).sort((a, b) => (a.year || 9999) - (b.year || 9999));
  }

  markFilm(key, status, wish = false) {
    const f = this.mustFilm(key);
    f.status = status;
    f.wish = !!wish;
    if (status !== 'candidate') this.dropNear(key);
    this.refreshTasks();
    this.afterQueueChange(f.dir);
    this.save();
    return this.state;
  }

  finishMarkup(dirId) {
    this.state.directors[dirId].marked = true;
    this.save();
    return this.state;
  }

  chooseNext(dirId, keys) {
    keys.forEach((k) => { const f = this.mustFilm(k); f.status = 'queue'; });
    this.state.directors[dirId].needsChoice = this.queueCount(dirId) < QUEUE_MIN;
    this.rebuildQueues();
    this.save();
    return this.state;
  }

  async searchAdd(query) {
    const [m, p] = await Promise.all([this.tmdb.searchMovie(query), this.tmdb.searchPerson(query)]);
    return {
      films: rank(query, null, m.results).filter((c) => !this.state.films[filmKey(c.id)] || this.state.films[filmKey(c.id)].status === 'candidate'),
      people: (p.results || []).filter((x) => x.known_for_department === 'Directing').slice(0, 5).map((x) => ({ id: x.id, name: x.name, inLibrary: !!this.state.directors[x.id] })),
    };
  }

  async addFilm(tmdbId) {
    const det = await this.detail(tmdbId);
    const f = this.ensureFilm(det);
    if (['candidate', 'disk'].includes(f.status)) f.status = 'queue';
    this.rebuildQueues();
    this.save();
    return { state: this.state, film: f };
  }

  async addDirector(person) {
    const d = this.ensureDirector(person);
    d.marked = true;
    d.needsChoice = true;
    await this.filmography(person.id);
    this.save();
    return { state: this.state, dirId: person.id };
  }
}

Object.assign(Service.prototype, require('./disks').diskMethods);

module.exports = { Service, findInFilmography, emptyState, filmKey, QUEUE_MIN, QUEUE_MAX, SHORT_MINUTES };
