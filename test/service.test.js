'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Service } = require('../src/service');
const { rank, isConfident, score } = require('../src/matcher');
const { createTmdb } = require('../src/tmdb');
const { fakeTmdb } = require('./fake-tmdb');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-'));
const ROM = [10, 'Эрик Ромер'];
const WEIR = [20, 'Питер Уир'];
const OTHER = [30, 'Другой'];
const MOVIES = [
  { id: 1, title: 'Знак Льва', year: 1962, directors: [ROM] },
  { id: 2, title: 'Любовь после полудня', year: 1972, directors: [ROM] },
  { id: 3, title: 'Галлиполи', year: 1981, directors: [WEIR] },
  { id: 4, title: 'Свидетель', year: 1985, directors: [WEIR] },
  { id: 5, title: 'Свидетель', year: 1999, directors: [OTHER] },
  { id: 6, title: 'Река', year: 1997, directors: [OTHER] },
  { id: 7, title: 'Река', year: 1997, original_title: 'He Liu', directors: [ROM] },
  { id: 8, title: 'Моя ночь у Мод', year: 1969, directors: [ROM] },
  { id: 9, title: 'Короткий', year: 1960, runtime: 20, directors: [ROM] },
  { id: 11, title: 'Посторонний', year: 2000, directors: [OTHER] },
  { id: 12, title: 'Сериальный', year: 2001, directors: [OTHER] },
];
const SEED = {
  skipped: [],
  groups: [
    { row: 2, films: [{ title: 'Знак Льва', year: 1962, link: 'https://www.kinopoisk.ru/film/1/' }, { title: 'Любовь после полудня', year: 1972 }] },
    { row: 3, films: [{ title: 'Галлиполи', year: 1981 }, { title: 'Свидетель', year: 1985 }] },
    { row: 4, films: [{ title: 'Река', year: 1997 }] },
    { row: 5, films: [{ title: 'Галлиполи', year: 1981 }, { title: 'Посторонний', year: 2000 }] },
    { row: 6, films: [{ title: 'Нет такого', year: 1950 }] },
  ],
  near: [
    { position: 0, source: 'Свидетель (1985) или Галлиполи', alternatives: [{ title: 'Свидетель', year: 1985 }, { title: 'Галлиполи', year: null }] },
    { position: 1, source: 'Моя ночь у Мод', alternatives: [{ title: 'Моя ночь у Мод', year: 1969 }] },
  ],
};
async function imported() {
  const s = new Service({ dir: tmp(), tmdb: fakeTmdb(MOVIES, { 10: [{ id: 1, job: 'Director', release_date: '1962-01-01' }, { id: 9, job: 'Director', release_date: '1960-01-01' }, { id: 8, job: 'Director', release_date: '1969-01-01' }, { id: 12, job: 'Writer', release_date: '2001-01-01' }] }) });
  s.loadSeed(SEED);
  await s.runImport();
  return s;
}

test('название с годом распознаётся уверенно, омонимы нет', () => {
  const c = rank('Река', 1997, [{ id: 6, title: 'Река', release_date: '1997-01-01' }, { id: 7, title: 'Река', release_date: '1997-02-02' }]);
  assert.equal(isConfident(c, 1997), false);
  const one = rank('Река', 1997, [{ id: 6, title: 'Река', release_date: '1997-01-01' }]);
  assert.equal(isConfident(one, 1997), true);
  assert.ok(score('Река', 1997, { title: 'Река', release_date: '2010-01-01' }) < 85);
});

test('импорт сверяет режиссёра строки и отдаёт спорное на разбор', async () => {
  const s = await imported();
  const st = s.getState();
  assert.equal(st.job.phase, 'review');
  assert.equal(st.films.m1.dir, 10);
  assert.equal(st.films.m1.userTitle, 'Знак Льва');
  assert.equal(st.films.m1.kpLink, 'https://www.kinopoisk.ru/film/1/');
  assert.equal(st.films.m4.dir, 20, 'строка выбрала Свидетеля Уира, а не омонима');
  assert.equal(st.films.m5, undefined);
  const titles = s.reviewList().map((r) => r.title).sort();
  assert.deepEqual(titles, ['Галлиполи', 'Нет такого', 'Посторонний', 'Река'].sort());
});

test('ближайшие: порядок сохранён, варианты «или» в одной строке, новый фильм добавлен', async () => {
  const st = (await imported()).getState();
  assert.equal(st.near[0].ids.join(), 'm4,m3');
  assert.equal(st.near[1].ids[0], 'm8');
  assert.equal(st.films.m8.status, 'queue');
});

test('разбор доводит импорт до конца и не дублирует фильмы', async () => {
  const s = await imported();
  for (const r of s.reviewList()) {
    if (r.cands.length) await s.resolveItem(r.id, r.cands[0].id); else s.skipItem(r.id);
  }
  const st = s.getState();
  assert.equal(st.job.phase, 'done');
  assert.equal(Object.values(st.films).filter((f) => f.tmdbId === 3).length, 1);
});

test('просмотр освобождает очередь, запрашивает выбор и убирает строку из ближайших', async () => {
  const s = await imported();
  const r = s.setFilmStatus('m4', 'watched');
  assert.equal(r.state.films.m4.pending, true);
  assert.equal(r.state.near.some((e) => e.ids.includes('m4')), false);
  assert.equal(r.state.near.some((e) => e.ids.includes('m3')), false, 'вся строка «или» уходит');
  assert.equal(s.setFilmStatus('m1', 'dropped').askDirector, null, 'в очереди ещё два фильма');
  assert.equal(s.setFilmStatus('m2', 'watched').askDirector, 10);
  s.applyResolved();
  assert.equal(s.getState().near.some((e) => e.source && e.source.startsWith('Свидетель')), false, 'строка не возвращается');
});

test('фильмография: только режиссура, без короткометражек', async () => {
  const s = await imported();
  const list = await s.filmography(10);
  const ids = list.map((f) => f.tmdbId);
  assert.ok(ids.includes(8));
  assert.ok(!ids.includes(9), 'короткометражка скрыта');
  assert.ok(!ids.includes(12), 'работа сценаристом скрыта');
});

test('запас: больше трёх фильмов не занимают очередь и подтягиваются сами', async () => {
  const s = await imported();
  for (const id of [101, 102, 103]) {
    s.ensureFilm({ id, title: `Ф${id}`, originalTitle: `Ф${id}`, year: 2000, directors: [{ id: 10, name: 'Эрик Ромер' }] }, { dir: 10 });
  }
  s.rebuildQueues();
  const count = (st) => Object.values(s.getState().films).filter((f) => f.dir === 10 && f.status === st).length;
  assert.equal(count('queue'), 3);
  assert.ok(count('reserve') >= 1);
  const before = count('reserve');
  const q = Object.values(s.getState().films).find((f) => f.dir === 10 && f.status === 'queue');
  s.setFilmStatus(q.key, 'watched');
  assert.equal(count('queue'), 3);
  assert.equal(count('reserve'), before - 1);
});

test('данные переживают перезапуск, импорт продолжается с места', async () => {
  const dir = tmp();
  const t = fakeTmdb(MOVIES);
  const s = new Service({ dir, tmdb: t });
  s.loadSeed(SEED);
  s.stopRequested = false;
  const orig = t.get;
  let n = 0;
  t.get = async (...a) => { if (++n === 3) s.stopImport(); return orig(...a); };
  await s.runImport();
  assert.equal(s.getState().job.phase, 'films');
  const again = new Service({ dir, tmdb: fakeTmdb(MOVIES) });
  assert.ok(again.getState().job.cursor > 0);
  await again.runImport();
  assert.equal(again.getState().job.phase, 'review');
  assert.equal(again.getState().films.m1.dir, 10);
});

test('неверный файл начальных данных отклоняется', () => {
  const s = new Service({ dir: tmp() });
  assert.throws(() => s.loadSeed({ foo: 1 }));
});

test('клиент TMDB: ключ и токен, ошибка ключа и повтор при лимите', async () => {
  let seen;
  const ok = { status: 200, ok: true, json: async () => ({ a: 1 }) };
  const v3 = createTmdb({ key: 'abc', minGapMs: 0, fetchImpl: async (u) => { seen = u; return ok; } });
  await v3.ping();
  assert.match(seen, /api_key=abc/);
  let hdr;
  const v4 = createTmdb({ key: 'eyJxx', minGapMs: 0, fetchImpl: async (u, o) => { seen = u; hdr = o.headers; return ok; } });
  await v4.ping();
  assert.ok(!/api_key/.test(seen));
  assert.equal(hdr.Authorization, 'Bearer eyJxx');
  const bad = createTmdb({ key: 'x', minGapMs: 0, fetchImpl: async () => ({ status: 401, ok: false }) });
  await assert.rejects(bad.ping(), (e) => e.kind === 'auth');
  let tries = 0;
  const limited = createTmdb({ key: 'x', minGapMs: 0, sleep: async () => {}, fetchImpl: async () => (++tries < 3 ? { status: 429, ok: false } : ok) });
  assert.deepEqual(await limited.ping(), { a: 1 });
  assert.equal(tries, 3);
});
