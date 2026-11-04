'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Service } = require('../src/service');
const { scanFolder, parseName, parseIfoSubtitles, subtitleSummary, MIN_FILM_BYTES } = require('../src/scanner');
const { fakeTmdb } = require('./fake-tmdb');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mnd-'));
function big(p, size = MIN_FILM_BYTES + 1) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}
const film = (id, title, year, extra = {}) => ({ key: `m${id}`, tmdbId: id, userTitle: title, tmdbTitle: null, originalTitle: extra.orig || title, year, dir: 1, status: 'queue', watched: [], runtime: extra.runtime || null, ...extra });
function svc(films = {}) {
  const s = new Service({ dir: tmp(), tmdb: fakeTmdb([{ id: 900, title: 'Новый', year: 2001, directors: [[9, 'Р']] }]) });
  s.state.films = films;
  s.state.directors = { 1: { id: 1, name: 'Р' } };
  return s;
}

test('разбор названий', () => {
  assert.deepEqual(parseName('Любовь – это дьявол (1998)'), { title: 'Любовь – это дьявол', year: 1998 });
  assert.deepEqual(parseName('Мечта'), { title: 'Мечта', year: null });
  assert.deepEqual(parseName('Зверофабрика 2000'), { title: 'Зверофабрика', year: 2000 });
  assert.deepEqual(parseName('1917'), { title: '1917', year: null });
  assert.deepEqual(parseName('1917 (2019)'), { title: '1917', year: 2019 });
  assert.deepEqual(parseName('The.Good.Life.2007.1080p.BluRay.x264.mkv', true), { title: 'The Good Life', year: 2007 });
  assert.equal(parseName('Бегущий по лезвию 2049').year, null, 'год из будущего не считается годом');
});

test('сканер: диск, папка, файлы, части, бонусы, сериалы, служебные папки', async () => {
  const r = tmp();
  big(path.join(r, 'Любовь – это дьявол (1998)', 'VIDEO_TS', 'VTS_02_1.VOB'));
  big(path.join(r, 'Любовь – это дьявол (1998)', 'VIDEO_TS', 'VTS_01_1.VOB'), 1000);
  big(path.join(r, 'Мечта', 'movie.mkv'));
  big(path.join(r, 'Мечта', 'sample.mkv'), 1000);
  big(path.join(r, 'Мечта', 'Extras', 'trailer.mkv'));
  big(path.join(r, 'Брошенный фильм 1990.avi'));
  big(path.join(r, 'Двухчастный', 'film CD1.avi'));
  big(path.join(r, 'Двухчастный', 'film CD2.avi'));
  big(path.join(r, 'Сериал', 'Show.S01E01.mkv'));
  big(path.join(r, 'Сериал', 'Show.S01E02.mkv'));
  big(path.join(r, 'Другой сериал', 'Сезон 1', 'a.mkv'));
  big(path.join(r, '#recycle', 'Удалённый (1999).mkv'));
  big(path.join(r, 'Коллекция', 'Первый (1950)', 'a.mkv'));
  big(path.join(r, 'Коллекция', 'Второй (1951)', 'b.mkv'));
  const { entries } = await scanFolder(r);
  const by = (t) => entries.find((e) => e.title === t);
  assert.equal(by('Любовь – это дьявол').kind, 'dvd');
  assert.equal(by('Любовь – это дьявол').mainSet, '02');
  assert.equal(by('Мечта').kind, 'folder');
  assert.equal(by('Брошенный фильм').kind, 'file');
  assert.equal(by('Двухчастный').kind, 'parts');
  assert.equal(by('Двухчастный').size, 2 * (MIN_FILM_BYTES + 1));
  assert.equal(by('Сериал').kind, 'series');
  assert.equal(by('Другой сериал').kind, 'series');
  assert.ok(by('Первый') && by('Второй'));
  assert.equal(entries.length, 8);
  assert.ok(!entries.some((e) => /Удалённый|trailer/.test(e.path)));
});

test('субтитры: DVD и файлы рядом', () => {
  const b = Buffer.alloc(0x300);
  b.write('DVDVIDEO-VTS', 0, 'latin1');
  b.writeUInt16BE(2, 0x254);
  b.write('en', 0x258, 'latin1');
  b.write('ru', 0x25e, 'latin1');
  assert.deepEqual(parseIfoSubtitles(b), ['en', 'ru']);
  assert.equal(subtitleSummary(['en'], []).state, 'other');
  assert.equal(subtitleSummary(['en'], ['film.rus.srt']).state, 'ru');
  assert.equal(subtitleSummary([], ['Русские.srt']).state, 'ru');
  assert.equal(subtitleSummary([], []).state, 'none');
});

test('сверка по любому названию, омонимы на выбор, связь запоминается и при переносе', async () => {
  const r = tmp();
  big(path.join(r, 'О! Су-джон! (2000)', 'a.mkv'));
  big(path.join(r, 'Virgin Stripped Bare (2000)', 'b.mkv'), MIN_FILM_BYTES + 5);
  big(path.join(r, 'Свидетель', 'c.mkv'));
  big(path.join(r, 'Никому не известный', 'd.mkv'));
  const s = svc({ m1: film(1, 'О! Су-джон!', 2000, { orig: 'Virgin Stripped Bare' }), m2: film(2, 'Свидетель', 1985), m3: film(3, 'Свидетель', 1999) });
  s.addFolder(r);
  await s.scanAll();
  const es = Object.values(s.getState().files);
  const by = (n) => es.find((e) => e.name === n);
  assert.equal(by('О! Су-джон! (2000)').filmKey, 'm1');
  assert.equal(by('Virgin Stripped Bare (2000)').filmKey, 'm1', 'оригинальное название');
  assert.equal(by('Свидетель').state, 'orphan');
  assert.deepEqual(by('Свидетель').candidates.sort(), ['m2', 'm3']);
  assert.equal(by('Никому не известный').state, 'orphan');
  s.chooseEntryFilm(by('Свидетель').id, 'm2');
  assert.equal(s.duplicates().length, 1, 'две копии одного фильма');
  assert.equal(s.duplicates()[0].identical, false);
  // Перенос в другую папку с тем же именем
  fs.renameSync(path.join(r, 'Свидетель'), path.join(r, 'Сегодня_Свидетель_tmp'));
  fs.mkdirSync(path.join(r, 'Сегодня'));
  fs.renameSync(path.join(r, 'Сегодня_Свидетель_tmp'), path.join(r, 'Сегодня', 'Свидетель'));
  await s.scanAll();
  const moved = Object.values(s.getState().files).find((e) => e.path.endsWith(path.join('Сегодня', 'Свидетель')));
  assert.equal(moved.filmKey, 'm2');
});

test('одинаковый размер: вероятная копия', async () => {
  const r = tmp();
  big(path.join(r, 'A', 'Фильм (2000)', 'a.mkv'));
  big(path.join(r, 'B', 'Фильм (2000)', 'a.mkv'));
  const s = svc({ m1: film(1, 'Фильм', 2000) });
  s.addFolder(r);
  await s.scanAll();
  assert.equal(s.duplicates()[0].identical, true);
  s.duplicateOk('m1');
  assert.equal(s.duplicates().length, 0);
});

test('задача на перенос: появляется, закрывается только без всех копий, можно оставить', async () => {
  const r = tmp();
  big(path.join(r, 'A', 'Фильм (2000)', 'a.mkv'));
  big(path.join(r, 'B', 'Фильм (2000)', 'a.mkv'));
  const s = svc({ m1: film(1, 'Фильм', 2000), m2: film(2, 'Пустой', 2001) });
  s.addFolder(r);
  await s.scanAll();
  s.setFilmStatus('m1', 'watched');
  s.markFilm('m2', 'watched');
  assert.equal(s.getState().films.m1.moveTask, true);
  assert.equal(s.getState().films.m2.moveTask, false, 'файла нет, задачи нет');
  fs.rmSync(path.join(r, 'A'), { recursive: true });
  await s.scanAll();
  assert.equal(s.getState().films.m1.moveTask, true, 'осталась копия');
  fs.rmSync(path.join(r, 'B'), { recursive: true });
  await s.scanAll();
  assert.equal(s.getState().films.m1.moveTask, false);
  const r2 = tmp();
  big(path.join(r2, 'Фильм2 (2003)', 'a.mkv'));
  const s2 = svc({ m1: film(1, 'Фильм2', 2003, { status: 'watched' }) });
  s2.addFolder(r2);
  await s2.scanAll();
  assert.equal(s2.getState().films.m1.moveTask, true, 'разметка до подключения дисков тоже учитывается');
  s2.keepOnDisk('m1');
  await s2.scanAll();
  assert.equal(s2.getState().films.m1.moveTask, false);
});

test('смена пути: задачи не закрываются, данные не теряются, новый путь связывается', async () => {
  const r = tmp();
  for (let i = 0; i < 12; i++) big(path.join(r, `Ф${i} (2000)`, 'a.mkv'), MIN_FILM_BYTES + i);
  const films = {};
  for (let i = 0; i < 12; i++) films[`m${i}`] = film(i, `Ф${i}`, 2000, { status: i ? 'queue' : 'watched' });
  const s = svc(films);
  s.addFolder(r);
  await s.scanAll();
  assert.equal(s.getState().films.m0.moveTask, true);
  const r2 = `${r}-new`;
  fs.renameSync(r, r2);
  await s.scanAll();
  const st = s.getState();
  assert.equal(Object.keys(st.lost).length, 1);
  assert.equal(st.lost[Object.keys(st.lost)[0]].count, 12);
  assert.equal(st.films.m0.moveTask, true, 'задача не закрылась');
  assert.equal(Object.keys(st.files).length, 12, 'файлы не забыты');
  await s.updateFolderPath(r, r2);
  assert.equal(Object.keys(s.getState().lost).length, 0);
  assert.equal(Object.values(s.getState().files).filter((e) => e.state === 'linked').length, 12);
  assert.ok(Object.values(s.getState().files).every((e) => e.path.startsWith(r2)));
});

test('пропала большая часть папки: нужно подтверждение, частичная уборка проходит сразу', async () => {
  const r = tmp();
  for (let i = 0; i < 20; i++) big(path.join(r, `Ф${i} (2000)`, 'a.mkv'));
  const s = svc({});
  s.addFolder(r);
  await s.scanAll();
  for (let i = 0; i < 3; i++) fs.rmSync(path.join(r, `Ф${i} (2000)`), { recursive: true });
  await s.scanAll();
  assert.equal(Object.keys(s.getState().files).length, 17);
  for (let i = 3; i < 15; i++) fs.rmSync(path.join(r, `Ф${i} (2000)`), { recursive: true });
  await s.scanAll();
  assert.equal(Object.keys(s.getState().files).length, 17, 'ждёт подтверждения');
  assert.equal(Object.keys(s.getState().lost).length, 1);
  await s.confirmLost(r);
  assert.equal(Object.keys(s.getState().files).length, 5);
});

test('папка «Фильмы2» не считается частью папки «Фильмы»', async () => {
  const r = tmp();
  big(path.join(r, 'Фильмы', 'А (2000)', 'a.mkv'));
  big(path.join(r, 'Фильмы2', 'Б (2001)', 'a.mkv'));
  const s = svc({});
  s.addFolder(path.join(r, 'Фильмы'));
  s.addFolder(path.join(r, 'Фильмы2'));
  await s.scanAll();
  s.removeFolder(path.join(r, 'Фильмы'));
  assert.equal(Object.keys(s.getState().files).length, 1);
});

test('«Уже смотрел» добавляет фильм и создаёт задачу; игнор запоминается', async () => {
  const r = tmp();
  big(path.join(r, 'Новый (2001)', 'a.mkv'));
  big(path.join(r, 'Лишнее (2002)', 'a.mkv'));
  const s = svc({});
  s.addFolder(r);
  await s.scanAll();
  const es = Object.values(s.getState().files);
  const a = es.find((e) => e.title === 'Новый');
  await s.addEntryFilm(a.id, 900, true);
  const f = s.getState().films.m900;
  assert.equal(f.status, 'watched');
  assert.equal(f.moveTask, true);
  assert.equal(f.userTitle, 'Новый');
  const b = es.find((e) => e.title === 'Лишнее');
  s.ignoreEntry(b.id);
  await s.scanAll();
  assert.equal(s.getState().files[b.id].state, 'ignored');
});

test('исключённая папка не сканируется; сериал не попадает в сверку', async () => {
  const r = tmp();
  big(path.join(r, 'Сериалы', 'X', 'a.S01E01.mkv'));
  big(path.join(r, 'Сериал2', 'a.S01E01.mkv'));
  big(path.join(r, 'Сериал2', 'a.S01E02.mkv'));
  const s = svc({});
  s.addFolder(r);
  s.addFolder(path.join(r, 'Сериалы'), 'exclude');
  await s.scanAll();
  const es = Object.values(s.getState().files);
  assert.ok(!es.some((e) => e.path.includes(path.join(r, 'Сериалы'))));
  assert.equal(es.find((e) => e.title === 'Сериал2').state, 'series');
});

test('переименование: только внешнее имя, с журналом и отменой, занятые имена пропускаются', async () => {
  const r = tmp();
  big(path.join(r, 'Мечта', 'VIDEO_TS', 'VTS_01_1.VOB'));
  big(path.join(r, 'Река', 'a.mkv'));
  big(path.join(r, 'Река (1997)', 'b.mkv'), MIN_FILM_BYTES + 9);
  const s = svc({ m1: film(1, 'Мечта', 1964), m2: film(2, 'Река', 1997) });
  s.addFolder(r);
  await s.scanAll();
  const plan = s.renamePlan();
  const dream = plan.find((p) => p.from === 'Мечта');
  assert.equal(dream.to, 'Мечта (1964)');
  const { failed } = await s.applyRename(plan.map((p) => p.id), plan.map((p) => p.id));
  assert.ok(fs.existsSync(path.join(r, 'Мечта (1964)', 'VIDEO_TS', 'VTS_01_1.VOB')), 'содержимое диска не тронуто');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].from, 'Река');
  assert.equal(s.getState().renameLog.length, 1);
  await s.undoRename(0);
  assert.ok(fs.existsSync(path.join(r, 'Мечта', 'VIDEO_TS')));
});

test('учёт на диске сохраняет связи и дубли без очереди и переживает перезапуск', async () => {
  const r = tmp();
  big(path.join(r, 'Новый (2001).mkv'));
  big(path.join(r, 'Новый (2001)', 'movie.mkv'));
  const s = svc();
  s.addFolder(r);
  await s.scanAll();
  const entry = Object.values(s.state.files)[0];
  await s.addEntryFilm(entry.id, 900, 'disk');
  assert.equal(s.state.films.m900.status, 'disk');
  assert.equal(s.queueCount(9), 0);
  assert.equal(s.state.directors[9].needsChoice, false);
  assert.equal(s.state.films.m900.pending, false);
  assert.equal(s.state.films.m900.moveTask, false);
  assert.equal(s.state.near.length, 0);
  assert.equal(s.filmEntries('m900').length, 2);
  assert.equal(s.duplicates().length, 1);
  const restored = new Service({ dir: s.dir, tmdb: s.tmdb });
  await restored.scanAll();
  restored.afterQueueChange(9);
  assert.equal(restored.state.films.m900.status, 'disk', 'не попадает в очередь автоматически');
  assert.equal(restored.filmEntries('m900').length, 2);
  await restored.addFilm(900);
  assert.equal(restored.state.films.m900.status, 'queue', 'можно явно добавить в очередь позже');
});

test('учёт новой копии не сбрасывает очередь, оценку и историю известного фильма', async () => {
  for (const status of ['queue', 'watched']) {
    const s = svc();
    const det = await s.detail(900);
    const f = s.ensureFilm(det, { status });
    f.rating = 8;
    f.watched = [{ date: '2026-11-01', result: 'watched' }];
    s.state.files = { copy: { id: 'copy', title: 'Другое имя', year: 2001, state: 'orphan' } };
    await s.addEntryFilm('copy', 900, 'disk');
    assert.equal(f.status, status);
    assert.equal(f.rating, 8);
    assert.deepEqual(f.watched, [{ date: '2026-11-01', result: 'watched' }]);
    assert.equal(s.state.files.copy.filmKey, 'm900');
  }
});

test('добавление сверх трёх требует подтверждения и сохраняет всю очередь после пересчёта и перезапуска', async () => {
  const s = svc();
  for (let i = 1; i <= 3; i++) s.state.films[`m${i}`] = film(i, `Фильм ${i}`, 2000, {dir:9});
  s.state.files = { x: { id:'x', title:'Новый', year:2001, state:'orphan' } };
  await assert.rejects(s.addEntryFilm('x', 900, 'queue'), /Подтверди/);
  assert.equal(s.queueCount(9), 3);
  assert.equal(s.state.files.x.state, 'orphan');
  await s.addEntryFilm('x', 900, 'queue', {allowExtra:true});
  assert.equal(s.queueCount(9), 4);
  s.rebuildQueues();
  assert.equal(s.queueCount(9), 4);
  const restored = new Service({dir:s.dir, tmdb:s.tmdb});
  restored.rebuildQueues();
  assert.equal(restored.queueCount(9), 4);
  assert.equal(restored.state.files.x.filmKey, 'm900');
});

test('замена сохраняет данные старого фильма и не возвращает его автоматически в очередь', async () => {
  const s = svc();
  for (let i = 1; i <= 3; i++) s.state.films[`m${i}`] = film(i, `Фильм ${i}`, 2000, {dir:9, rating:8});
  s.state.files = {old:{id:'old',filmKey:'m1',state:'linked'}, x:{id:'x',title:'Новый',year:2001,state:'orphan'}};
  await assert.rejects(s.addEntryFilm('x',900,'queue',{replaceKey:'missing'}), /уже не находится/);
  await s.addEntryFilm('x',900,'queue',{replaceKey:'m1'});
  assert.equal(s.queueCount(9),3);
  assert.equal(s.state.films.m1.status,'disk');
  assert.equal(s.state.films.m1.rating,8);
  assert.equal(s.state.files.old.filmKey,'m1');
  s.rebuildQueues();
  s.afterQueueChange(9);
  assert.equal(s.state.films.m1.status,'disk');
  assert.equal(s.state.films.m900.status,'queue');
});

test('добавление учтённого фильма соблюдает подтверждение и очередь из сведений о кандидате', async () => {
  const s=svc();
  for(let i=1;i<=3;i++) s.state.films[`m${i}`]=film(i,`Фильм ${i}`,2000,{dir:9});
  await assert.rejects(s.addFilm(900), /Подтверди/);
  await s.addFilm(900,{allowExtra:true});
  assert.equal(s.queueCount(9),4);
  const info=await s.candidateInfo([900]);
  assert.deepEqual(info[900].directorIds,[9]);
});

test('игнорирование можно отменить после повторного сканирования и перезапуска', async () => {
  const r=tmp(); big(path.join(r,'Неизвестный.mkv'));
  const s=svc(); s.addFolder(r); await s.scanAll();
  const id=Object.keys(s.state.files)[0];
  s.ignoreEntry(id); await s.scanAll();
  assert.equal(s.state.files[id].state,'ignored');
  const restored=new Service({dir:s.dir,tmdb:s.tmdb});
  restored.unignoreEntry(id);
  assert.equal(restored.state.files[id].state,'orphan');
  assert.ok(fs.existsSync(restored.state.files[id].path));
});

test('год без подтверждения не меняется; исправление связи сохраняется после сканирования', async () => {
  const r=tmp(); big(path.join(r,'Комната.mkv'));
  const s=svc({m1:film(1,'Комната',1993)}); s.addFolder(r); await s.scanAll();
  const id=Object.keys(s.state.files)[0];
  let plan=s.renamePlan();
  assert.equal(plan[0].matchMethod,'name');
  assert.equal(plan[0].requiresConfirmation,true);
  const result=await s.applyRename([id]);
  assert.equal(result.failed.length,1);
  assert.ok(fs.existsSync(path.join(r,'Комната.mkv')));
  s.unlinkEntry(id); await s.scanAll();
  assert.equal(s.state.files[id].state,'orphan');
  assert.equal(s.renamePlan().length,0);
  const restored=new Service({dir:s.dir,tmdb:s.tmdb}); await restored.scanAll();
  assert.equal(restored.state.files[id].state,'orphan');
  restored.chooseEntryFilm(id,'m1');
  assert.equal(restored.state.files[id].matchMethod,'manual');
  plan=restored.renamePlan();
  assert.equal(plan[0].requiresConfirmation,true,'добавление года подтверждается отдельно даже после выбора фильма');
  const renamed=await restored.applyRename([id],[id]);
  assert.equal(renamed.failed.length,0);
  assert.ok(fs.existsSync(path.join(r,'Комната (1993).mkv')));
});

test('старые связи неизвестного происхождения и расхождение года требуют подтверждения', async () => {
  const s=svc({m1:film(1,'Фильм',1993)});
  s.state.files={x:{id:'x',path:'/tmp/Фильм 1993.mkv',name:'Фильм 1993.mkv',title:'Фильм',year:1993,kind:'file',state:'linked',filmKey:'m1'}};
  assert.equal(s.renamePlan()[0].matchMethod,'unknown');
  assert.equal(s.renamePlan()[0].requiresConfirmation,true);
  s.state.files.x.matchMethod='name-year';
  assert.equal(s.renamePlan()[0].requiresConfirmation,false);
  s.state.files.x.year=1992;
  assert.equal(s.renamePlan()[0].requiresConfirmation,true);
});

// Exercise the renderer's real loader without a real TMDB key or an Electron window.
function orphanRenderer(invoke) {
  const vm = require('node:vm');
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    document: { getElementById: () => ({}), querySelector: () => null, addEventListener() {} },
    window: { scrollTo() {}, addEventListener() {}, api: {
      call: (method, ...args) => method === 'version' ? new Promise(() => {}) : invoke(method, ...args),
      onProgress() {}, onScan() {}, onUpdate() {},
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8'), context);
  vm.runInContext(`globalThis.actualRender = render; render = () => {}; ui.screen = 'disks'; ui.diskTab = 'orphans';
    ui.state = { files: {}, films: {}, directors: {} }; ui.orphanShown = 1;`, context);
  return { run: (code) => vm.runInContext(code, context) };
}

test('разбор: новые видимые карточки загружаются после удаления верхней во время запроса', async () => {
  let renderer;
  const queries = [];
  renderer = orphanRenderer(async (method, query) => {
    if (method === 'searchForReview') {
      queries.push(query);
      if (query === 'Первый') renderer.run("ui.state.files.a.state = 'linked'");
      return { cands: [{ id: queries.length }] };
    }
    return { [query[0]]: { poster: '/poster.jpg' } };
  });
  renderer.run("ui.state.files = { a: { id:'a', title:'Первый', state:'orphan' }, b: { id:'b', title:'Второй', state:'orphan' } }");
  await renderer.run('loadOrphans()');
  assert.deepEqual(queries, ['Первый', 'Второй']);
  assert.equal(renderer.run('ui.candInfo[2].poster'), '/poster.jpg');
  await renderer.run('loadOrphans()');
  assert.equal(queries.length, 2, 'готовые результаты не запрашиваются бесконечно');
});

test('разбор: сбой сведений не блокирует следующие карточки и повтор не теряет сохранённый поиск', async () => {
  let fail = true, searches = 0;
  const renderer = orphanRenderer(async (method, arg) => {
    if (method === 'searchForReview') { searches++; return { cands: [{ id: arg === 'Первый' ? 1 : 2 }] }; }
    if (arg[0] === 1 && fail) throw new Error('temporary outage');
    return { [arg[0]]: { poster: '/poster.jpg' } };
  });
  renderer.run("ui.orphanShown=2;ui.state.files={ a:{id:'a',title:'Первый',state:'orphan'}, b:{id:'b',title:'Второй',state:'orphan'} }");
  await renderer.run('loadOrphans()');
  assert.equal(renderer.run('!!ui.orphanErrors.a'), true);
  assert.equal(renderer.run('!!ui.candInfo[2]'), true);
  assert.equal(renderer.run('ui.orphanLoading'), false);
  assert.match(renderer.run("orphanCard(ui.state.files.a)"), /Повторить загрузку/);
  fail=false;
  await renderer.run("retryOrphan('a')");
  assert.equal(renderer.run('!!ui.candInfo[1]'), true);
  assert.equal(searches, 2, 'повторно загружаются сведения, а не уже успешный поиск');
});

test('разбор: отсутствие результатов отличается от незавершённой загрузки', async () => {
  const renderer = orphanRenderer(async () => ({ cands: [] }));
  renderer.run("ui.state.files={a:{id:'a',title:'Первый',state:'orphan'}}");
  await renderer.run('loadOrphans()');
  assert.match(renderer.run('orphanCard(ui.state.files.a)'), /Вариантов не найдено/);
  assert.equal(renderer.run('ui.orphanLoading'), false);
});

test('разбор: перерисовка после завершённой загрузки подхватывает следующую карточку', async () => {
  const searched=[];
  const renderer=orphanRenderer(async (method,arg) => {
    if(method==='searchForReview'){searched.push(arg); return {cands:[]};}
    return {};
  });
  renderer.run("ui.hasKey=true;ui.state.folders=[];ui.state.near=[];ui.state.films={m1:{key:'m1',dir:1,status:'queue'}};ui.state.files={a:{id:'a',title:'Первый',state:'orphan'},b:{id:'b',title:'Второй',state:'orphan'}}");
  await renderer.run('loadOrphans()');
  assert.deepEqual(searched,['Первый']);
  renderer.run("ui.state.files.a.state='linked';actualRender()");
  await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(searched,['Первый','Второй']);
});

test('разбор: у фильма из очереди показаны статус и привязка вместо повторного добавления', async () => {
  const calls=[];
  const renderer=orphanRenderer(async (...args)=>{calls.push(args);return {films:{},files:{},directors:{}};});
  renderer.run("ui.state.films.m1={key:'m1',dir:9,status:'queue',userTitle:'Белый, белый день'};ui.orphanSearch.x=[{id:1,title:'Белый, белый день',year:2019}];ui.candInfo[1]={directors:['Режиссёр'],runtime:109};");
  const html=renderer.run("orphanCard({id:'x',title:'Файл',kind:'file'})");
  assert.match(html,/Уже в очереди/);
  assert.doesNotMatch(html,/>Добавить в очередь</);
  const button=html.match(/data-a="([^"]+)"[^>]*>Это он — связать файл/);
  assert.ok(button);
  await renderer.run(`actions['${button[1]}']()`);
  assert.deepEqual(calls,[['chooseEntryFilm','x','m1']]);
});

test('связь нового файла сохраняет статус, очередь, оценки и историю известного фильма', () => {
  for(const status of ['queue','reserve','disk','watched','dropped']) {
    const s=svc({m1:film(1,'Белый, белый день',2019,{status,rating:8,queueChosen:true,watched:[{date:'2026-11-01',result:'watched'}]})});
    s.state.files={x:{id:'x',title:'Другое имя',year:2019,state:'orphan'}};
    const before=JSON.stringify(s.state.films.m1);
    s.chooseEntryFilm('x','m1');
    const after={...s.state.films.m1}; delete after.moveTask;
    assert.equal(JSON.stringify(after),before);
    assert.equal(s.state.files.x.filmKey,'m1');
    assert.equal(s.state.files.x.matchMethod,'manual');
  }
});

test('кнопка проверки дублей пересканирует файлы и обновляет карточки без перезапуска', async () => {
  const r=tmp();
  big(path.join(r,'Копия А','Фильм (2000).mkv'));
  big(path.join(r,'Копия Б','Фильм (2000).mkv'));
  const s=svc({m1:film(1,'Фильм',2000)});
  s.addFolder(r); await s.scanAll();
  for(const e of Object.values(s.state.files)) s.chooseEntryFilm(e.id,'m1');
  assert.equal(s.duplicates().length,1);
  const renderer=orphanRenderer(async (method,...args)=>s[method](...args));
  renderer.run(`ui.screen='disks';ui.diskTab='dups';ui.state=${JSON.stringify(s.state)};ui.dups=${JSON.stringify(s.duplicates())};ui.plan=[];`);
  const html=renderer.run('disks()');
  const button=html.match(/data-a="([^"]+)"[^>]*>Я разобрал — проверить/);
  assert.ok(button);
  fs.rmSync(path.join(r,'Копия Б'),{recursive:true});
  await renderer.run(`actions['${button[1]}']()`);
  assert.equal(renderer.run('ui.dups.length'),0);
  assert.match(renderer.run('ui.toast'),/дублей не осталось/);
  assert.equal(s.filmEntries('m1').length,1);
});

test('проверка дублей не объявляет задачу выполненной при недоступной папке', async () => {
  const r=tmp(); big(path.join(r,'Фильм (2000).mkv'));
  const s=svc({m1:film(1,'Фильм',2000)});s.addFolder(r);await s.scanAll();
  fs.renameSync(r,r+'-offline');
  const renderer=orphanRenderer(async (method,...args)=>s[method](...args));
  renderer.run(`ui.screen='disks';ui.diskTab='dups';ui.state=${JSON.stringify(s.state)};`);
  await renderer.run('verifyDuplicates()');
  assert.match(renderer.run('ui.toast'),/Проверка неполная/);
  assert.equal(renderer.run('ui.scan'),null);
});

test('имена релизов: BDRemux и L2 удаляются до разбора года', () => {
  assert.deepEqual(parseName('Дорога к дому (Jibeuro) (2002) BDRemux.mkv',true),{title:'Дорога к дому (Jibeuro)',year:2002});
  assert.deepEqual(parseName('Silenced.2011.L2.BDRip.720p.Goliaf.mkv',true),{title:'Silenced',year:2011});
});

test('переименование использует связанный русский фильм, а не техническое имя релиза', async () => {
  const examples=[
    {name:'Дорога к дому (Jibeuro) (2002) BDRemux.mkv', oldTitle:'Дорога к дому (Jibeuro) (2002) BDRemux', title:'Дорога к дому',year:2002},
    {name:'Silenced.2011.L2.BDRip.720p.Goliaf.mkv',oldTitle:'Silenced 2011 L2',title:'Суровое испытание',year:2011},
  ];
  for(const ex of examples){
    const r=tmp();big(path.join(r,ex.name));
    const s=svc({m1:film(1,ex.oldTitle,ex.year,{tmdbTitle:ex.title})});
    s.addFolder(r);await s.scanAll();
    const id=Object.keys(s.state.files)[0];s.chooseEntryFilm(id,'m1');
    // Reproduce records saved by the previous scanner, without erasing the user's data.
    s.state.files[id].title=ex.oldTitle;
    const p=s.renamePlan()[0];assert.equal(p.to,`${ex.title} (${ex.year}).mkv`);
    assert.equal(p.title,ex.title);assert.equal(p.requiresConfirmation,true);
    assert.equal(s.state.films.m1.userTitle,ex.oldTitle,'сохранённое название не переписывается молча');
    const renamed=await s.applyRename([id],[id]);assert.equal(renamed.failed.length,0);
    assert.ok(fs.existsSync(path.join(r,`${ex.title} (${ex.year}).mkv`)));
    assert.equal(s.renamePlan().length,0,'год не добавляется повторно');
    await s.scanAll();assert.equal(s.renamePlan().length,0);
  }
});

test('название из файла не подменяет ручное название и не удаляет числа из названия фильма', () => {
  const {renameTitle}=require('../src/filenames');
  assert.equal(renameTitle({userTitle:'Моё название',titleSource:'manual',tmdbTitle:'Другой перевод',year:2002},{title:'BDRemux'}),'Моё название');
  assert.equal(renameTitle({userTitle:'2001 год: Космическая одиссея',titleSource:'table',year:1968},{title:'Release'}),'2001 год Космическая одиссея');
  assert.equal(renameTitle({userTitle:'1917',titleSource:'manual',year:2019},{title:'Release'}),'1917');
  assert.equal(renameTitle({userTitle:'Бегущий по лезвию 2049',titleSource:'manual',year:2017},{title:'Release'}),'Бегущий по лезвию 2049');
  assert.equal(renameTitle({userTitle:'Дорога к дому (2002) (2002)',titleSource:'manual',year:2002},{title:'Release'}),'Дорога к дому');
  assert.equal(renameTitle({userTitle:'Дорога к дому (Jibeuro) BDRemux',titleSource:'disk',tmdbTitle:'집으로',year:2002},{title:'Release'}),'Дорога к дому');
});

test('источник пользовательского названия сохраняется для файлов и явных правок', async () => {
  const s=svc();s.state.files={x:{id:'x',title:'Новый BDRemux',year:2001,state:'orphan'}};
  await s.addEntryFilm('x',900,'disk');
  assert.equal(s.state.films.m900.titleSource,'disk');
  s.setTitle('m900','Личное название');
  const restored=new Service({dir:s.dir});
  assert.equal(restored.state.films.m900.titleSource,'manual');
  assert.equal(restored.state.films.m900.userTitle,'Личное название');
});
