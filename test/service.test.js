'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Service, findInFilmography } = require('../src/service');
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

test('поиск в фильмографии не угадывает при неоднозначности', () => {
  const list = [{ id: 1, title: 'А', release_date: '2000-01-01' }, { id: 2, title: 'Б', release_date: '2000-05-01' }];
  assert.equal(findInFilmography(list, 'Другое', 2000), null);
  assert.equal(findInFilmography(list, 'Б', 2000).id, 2);
  assert.equal(findInFilmography([{ id: 3, title: 'В', release_date: '1990-01-01' }], 'Другое', 1990).id, 3);
  assert.equal(findInFilmography([{ id: 3, title: 'В', release_date: '1990-01-01' }], 'Другое', 1991), null);
});

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

test('спорный фильм находится в фильмографии режиссёра из той же строки', async () => {
  const movies = [
    { id: 21, title: 'Сказочник', year: 2001, directors: [[40, 'Тодд Солондз']] },
    { id: 22, title: 'Fear, Anxiety and Depression', year: 1989, directors: [[40, 'Тодд Солондз']] },
  ];
  const t = fakeTmdb(movies, { 40: [{ id: 22, title: 'Fear, Anxiety and Depression', original_title: 'Fear, Anxiety and Depression', job: 'Director', release_date: '1989-01-01' }, { id: 21, title: 'Сказочник', original_title: 'Storytelling', job: 'Director', release_date: '2001-01-01' }] });
  const s = new Service({ dir: tmp(), tmdb: t });
  s.loadSeed({ skipped: [], near: [], groups: [{ row: 2, films: [{ title: 'Страх, тревога и депрессия', year: 1989 }, { title: 'Сказочник', year: 2001 }] }] });
  await s.runImport();
  assert.equal(s.reviewList().length, 2);
  const r = await s.rescueReview();
  assert.equal(r.left, 0);
  assert.equal(s.getState().job.phase, 'done');
  assert.equal(s.getState().films.m22.userTitle, 'Страх, тревога и депрессия', 'остаётся название пользователя');
  assert.equal(s.getState().films.m22.dir, 40);
});

test('ручной поиск понимает год в скобках и ссылку TMDB', async () => {
  const t = fakeTmdb([{ id: 31, title: 'The Good Life', year: 2007, directors: [[50, 'Режиссёр']] }, { id: 32, title: 'The Good Life', year: 1996, directors: [[51, 'Другой']] }]);
  const s = new Service({ dir: tmp(), tmdb: t });
  const r = await s.searchForReview('The Good Life (2007)');
  assert.equal(r.cands[0].id, 31);
  assert.equal((await s.searchForReview('The Good Life 2007')).cands[0].id, 31);
  assert.equal((await s.searchForReview('https://www.themoviedb.org/movie/32?language=ru-RU')).cands[0].id, 32);
});

test('подтверждение одного фильма ищет второй у того же режиссёра', async () => {
  const movies = [{ id: 41, title: 'Virgin Stripped Bare by Her Bachelors', year: 2000, directors: [[60, 'Хон Сан Су']] }, { id: 42, title: 'Woman Is the Future of Man', year: 2004, directors: [[60, 'Хон Сан Су']] }];
  const t = fakeTmdb(movies, { 60: [{ id: 41, title: movies[0].title, original_title: movies[0].title, job: 'Director', release_date: '2000-01-01' }, { id: 42, title: movies[1].title, original_title: movies[1].title, job: 'Director', release_date: '2004-01-01' }] });
  const s = new Service({ dir: tmp(), tmdb: t });
  s.loadSeed({ skipped: [], near: [], groups: [{ row: 2, films: [{ title: 'О! Су-джон!', year: 2000 }, { title: 'Женщина — это будущее мужчины', year: 2004 }] }] });
  await s.runImport();
  assert.equal(s.reviewList().length, 2);
  const list = await s.resolveItem(0, 41);
  assert.equal(list.length, 0);
  const st = s.getState();
  assert.equal(st.films.m41.userTitle, 'О! Су-джон!');
  assert.equal(st.films.m42.userTitle, 'Женщина — это будущее мужчины');
  assert.equal(st.films.m42.dir, 60);
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

test('оценки при разметке сохраняются без выдуманной даты просмотра и утренней задачи', async () => {
  const s = await imported();
  s.markFilm('m1', 'watched');
  assert.equal(s.state.films.m1.pending, false);
  assert.deepEqual(s.state.films.m1.watched, []);
  s.rate('m1', 7);
  const restored = new Service({ dir: s.dir });
  assert.equal(restored.state.films.m1.rating, 7);
  assert.equal(restored.state.films.m1.status, 'watched');
  assert.deepEqual(restored.state.films.m1.watched, []);
  assert.equal(restored.state.films.m1.pending, false);
  restored.rate('m1', 9);
  assert.equal(restored.state.films.m1.rating, 9);
  for (const rating of [0, 11, 6.5, '7', NaN, undefined]) {
    assert.throws(() => restored.rate('m1', rating), /от 1 до 10/);
    assert.equal(restored.state.films.m1.rating, 9);
  }
  restored.rate('m1', null);
  assert.equal(new Service({ dir: s.dir }).state.films.m1.rating, null);
  assert.equal(restored.state.films.m1.status, 'watched');
});

test('TMDB: зависший запрос или чтение ответа завершаются по тайм-ауту, следующий запрос работает', async () => {
  for (const stuckBody of [false, true]) {
    let stuck = true, aborted = 0;
    const client = createTmdb({ key: 'test', minGapMs: 0, sleep: async () => {}, requestTimeoutMs: 5,
      fetchImpl: async (_url, options) => {
        if (!stuck) return { ok: true, status: 200, json: async () => ({ recovered: true }) };
        options.signal.addEventListener('abort', () => { aborted++; });
        if (stuckBody) return { ok: true, status: 200, json: () => new Promise(() => {}) };
        return new Promise(() => {});
      },
    });
    await assert.rejects(client.ping(), (e) => e.kind === 'network');
    assert.equal(aborted, 4);
    stuck = false;
    assert.deepEqual(await client.ping(), { recovered: true });
  }
});

test('личное имя режиссёра сохраняет варианты поиска и данные после перезапуска', async () => {
  const s = await imported();
  const before = JSON.stringify({films:s.state.films,near:s.state.near});
  s.state.directors[10].name = '贾樟柯';
  delete s.state.directors[10].tmdbName;
  s.setDirectorName(10, 'Цзя Чжанкэ');
  s.ensureDirector({id:10,name:'Jia Zhangke'});
  assert.equal(s.state.directors[10].name, 'Цзя Чжанкэ');
  s.save();
  const restored = new Service({dir:s.dir});
  assert.equal(restored.state.directors[10].name, 'Цзя Чжанкэ');
  assert.ok(restored.state.directors[10].aliases.includes('贾樟柯'));
  assert.ok(restored.state.directors[10].aliases.includes('Jia Zhangke'));
  assert.equal(JSON.stringify({films:restored.state.films,near:restored.state.near}), before);
  restored.setDirectorName(10, '');
  assert.equal(restored.state.directors[10].name, '贾樟柯');
  assert.ok(restored.state.directors[10].aliases.includes('Цзя Чжанкэ'));
});

test('варианты TMDB добавляют русское имя, сохраняют ручное и проверяют ID', async () => {
  const s = await imported();
  s.tmdb = {get:async p=>{assert.equal(p,'/person/10');return {id:10,name:'贾樟柯',also_known_as:['Jia Zhangke','Цзя Чжанкэ']};}};
  await s.refreshDirectorNames(10);
  assert.equal(s.state.directors[10].name, 'Цзя Чжанкэ');
  s.setDirectorName(10, 'Моё имя');
  await s.refreshDirectorNames(10);
  assert.equal(s.state.directors[10].name, 'Моё имя');
  const before=JSON.stringify(s.state);
  s.tmdb={get:async()=>({id:11,name:'Другой'})};
  await assert.rejects(s.refreshDirectorNames(10), /другом человеке/);
  assert.equal(JSON.stringify(s.state),before);
});

test('повторное добавление ближайшего фильма не создаёт дубль', async () => {
  const s=await imported();
  const before=JSON.stringify(s.state.near);
  s.addNear('m4');
  assert.equal(JSON.stringify(s.state.near),before);
  s.addNear('m1');s.addNear('m1');
  assert.equal(s.state.near.filter(e=>e.ids.includes('m1')).length,1);
});
