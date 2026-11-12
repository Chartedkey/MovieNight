'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Service } = require('../src/service');

function fixture(t, folder = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'library'), today = path.join(root, 'today');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(today);
  const source = path.join(sourceRoot, folder ? 'Movie (2000)' : 'Movie (2000).mkv');
  if (folder) fs.mkdirSync(source);
  const video = folder ? path.join(source, 'movie.mkv') : source;
  fs.writeFileSync(video, 'movie content');
  const sub = folder ? path.join(source, 'movie.ru.srt') : path.join(sourceRoot, 'Movie (2000).ru.srt');
  fs.writeFileSync(sub, 'subtitle content');
  const svc = new Service({ dir: path.join(root, 'db') });
  svc.state.films = { m1: { key: 'm1', userTitle: 'Личное имя', dir: 1, year: 2000, status: 'queue', rating: 9, watched: [], nightTags: { weight: 'light' } } };
  svc.state.directors = { 1: { id: 1, name: 'Имя', queue: ['m1'], fav: true } };
  svc.state.near = [{ key: 'near', ids: ['m1'] }];
  svc.state.nights = [{ id: 'night', slots: [{ key: 'm1', title: 'Личное имя', result: null }], tasks: {} }];
  svc.state.folders = [{ path: sourceRoot, role: 'normal', status: 'ok' }, { path: today, role: 'today', status: 'ok' }];
  svc.state.files = { entry: { id: 'entry', path: source, video, file: path.basename(video), kind: folder ? 'folder' : 'file', filmKey: 'm1', state: 'linked', role: 'normal', size: 13, title: 'Movie', year: 2000, matchMethod: 'manual', duration: 90, subs: { state: 'ru' }, renamePreference: 'custom', customName: 'Название' } };
  svc.save();
  return { svc, root, sourceRoot, source, today, video, sub, target: path.join(today, path.basename(source)), preview: () => svc.previewNightTransfer('night', 0, 'entry') };
}

for (const folder of [false, true]) test(`перенос ${folder ? 'всей папки' : 'файла с субтитрами'}: SHA-256, прогресс, связи и перезапуск`, async t => {
  const f = fixture(t, folder), before = structuredClone({ films: f.svc.state.films, near: f.svc.state.near, directors: f.svc.state.directors });
  if (folder) { fs.mkdirSync(path.join(f.source, 'empty')); fs.mkdirSync(path.join(f.source, 'extras')); fs.writeFileSync(path.join(f.source, 'extras', 'notes.txt'), 'notes'); }
  const p = await f.preview();
  assert.equal(fs.existsSync(f.target), false); assert.equal(p.files.length, folder ? 3 : 2);
  const phases = []; f.svc.onTransfer = p => phases.push(p.phase);
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(f.source), false); assert.equal(fs.existsSync(f.sub), false);
  assert.equal(fs.readFileSync(folder ? path.join(f.target, 'movie.mkv') : f.target, 'utf8'), 'movie content');
  assert.equal(fs.readFileSync(folder ? path.join(f.target, 'movie.ru.srt') : path.join(f.today, path.basename(f.sub)), 'utf8'), 'subtitle content');
  if (folder) assert.ok(fs.statSync(path.join(f.target, 'empty')).isDirectory());
  assert.deepEqual(f.svc.state.films, before.films); assert.deepEqual(f.svc.state.near, before.near); assert.deepEqual(f.svc.state.directors, before.directors);
  const entry = f.svc.state.files[f.target.toLowerCase()]; assert.equal(entry.path, f.target); assert.equal(entry.role, 'today'); assert.equal(entry.filmKey, 'm1'); assert.equal(entry.customName, 'Название'); assert.equal(entry.matchMethod, 'manual'); assert.equal(entry.subs.state, 'ru');
  assert.equal(f.svc.state.nights[0].tasks['0:file'], true);
  assert.ok(phases.includes('copying') && phases.includes('verifying') && phases.includes('deleting')); assert.equal(phases.at(-1), 'completed');
  const restored = new Service({ dir: f.svc.dir }); assert.equal(restored.state.files[entry.id].role, 'today'); assert.equal(restored.state.nightTransfers[0].status, 'completed');
  await assert.rejects(f.svc.executeNightTransfer(p.token), /устарел/);
});

test('предпросмотр не захватывает субтитры другого фильма с похожим префиксом', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.sourceRoot, 'Movie (2000)2.ru.srt'), 'other');
  assert.equal((await f.preview()).files.length, 2);
});
test('существующие файл, папка и регистровый конфликт не перезаписываются', async t => {
  for (const folder of [false, true]) {
    const f = fixture(t, folder); fs.writeFileSync(path.join(f.today, path.basename(f.target).toUpperCase()), 'existing');
    await assert.rejects(f.preview(), /занято/); assert.equal(fs.readFileSync(f.video, 'utf8'), 'movie content');
  }
});
test('конфликт внешних субтитров блокирует весь перенос', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.today, path.basename(f.sub)), 'existing subtitle'); await assert.rejects(f.preview(), /занято/);
});
test('изменившиеся исходник, состав папки и настройки требуют нового предпросмотра', async t => {
  for (const change of ['file', 'folder', 'destination']) {
    const f = fixture(t, true), p = await f.preview();
    if (change === 'file') fs.writeFileSync(f.video, 'changed');
    if (change === 'folder') fs.writeFileSync(path.join(f.source, 'new.txt'), 'new');
    if (change === 'destination') { const d = path.join(f.root, 'other'); fs.mkdirSync(d); f.svc.state.folders[1].path = d; }
    await assert.rejects(f.svc.executeNightTransfer(p.token), /изменил/); assert.ok(fs.existsSync(f.source)); assert.equal(fs.existsSync(f.target), false);
  }
});
test('конфликт, возникший после предпросмотра, сохраняет обе стороны', async t => {
  const f = fixture(t), p = await f.preview(); fs.writeFileSync(f.target, 'existing'); await assert.rejects(f.svc.executeNightTransfer(p.token), /занято/); assert.equal(fs.readFileSync(f.target, 'utf8'), 'existing'); assert.ok(fs.existsSync(f.source));
});
test('эксклюзивное создание защищает от гонки непосредственно при записи', async t => {
  const f = fixture(t), p = await f.preview(); let injected = false;
  f.svc.onTransfer = e => { if (e.phase === 'copying' && !injected) { injected = true; fs.writeFileSync(f.target, 'racing writer'); } };
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.ok(fs.existsSync(f.source)); assert.equal(fs.readFileSync(f.target, 'utf8'), 'racing writer');
});
test('повреждение копии при проверке не удаляет источник', async t => {
  const f = fixture(t), p = await f.preview(); let once = false;
  f.svc.onTransfer = e => { if (e.phase === 'verifying' && !once) { once = true; fs.writeFileSync(f.target, 'broken'); } };
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.match(r.error, /SHA-256/); assert.equal(r.sourceRestored, true); assert.equal(fs.readFileSync(f.source, 'utf8'), 'movie content'); assert.equal(f.svc.state.files.entry.path, f.source);
});
test('ошибка записи и отмена сохраняют исходник и показывают ошибку', async t => {
  for (const fail of ['write', 'cancel']) {
    const f = fixture(t), p = await f.preview(); let once = false;
    f.svc.onTransfer = e => { if (e.phase === 'copying' && !once) { once = true; if (fail === 'cancel') f.svc.cancelNightTransfer(); else fs.rmdirSync(f.today); } };
    const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.equal(r.sourceRestored, true); assert.ok(fs.existsSync(f.source)); assert.ok(fs.existsSync(f.sub));
  }
});
test('изменение или новый файл перед удалением запрещают удаление', async t => {
  for (const change of ['file', 'new']) {
    const f = fixture(t, true), p = await f.preview(); let once = false;
    f.svc.onTransfer = e => { if (e.phase === 'verifying' && !once) { once = true; if (change === 'file') fs.writeFileSync(f.video, 'changed during copy'); else fs.writeFileSync(path.join(f.source, 'new.txt'), 'new'); } };
    const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.ok(fs.existsSync(f.video)); assert.ok(fs.existsSync(f.sub));
  }
});
test('сбой удаления второго файла восстанавливает уже удалённый первый', async t => {
  const f = fixture(t, true), p = await f.preview(); const original = fs.promises.unlink; let count = 0;
  t.mock.method(fs.promises, 'unlink', async function(p) { if (++count === 2) throw Error('SMB deletion refused'); return original.call(this, p); });
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.equal(r.sourceRestored, true); assert.equal(fs.readFileSync(f.video, 'utf8'), 'movie content'); assert.equal(fs.readFileSync(f.sub, 'utf8'), 'subtitle content'); assert.equal(f.svc.state.files.entry.path, f.source);
});
test('новый файл во время удаления папки не удаляется, исходник восстанавливается', async t => {
  const f = fixture(t, true), p = await f.preview();
  f.svc.onTransfer = e => { if (e.phase === 'deleting') fs.writeFileSync(path.join(f.source, 'new.txt'), 'do not delete'); };
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.equal(r.sourceRestored, true); assert.equal(fs.readFileSync(path.join(f.source, 'new.txt'), 'utf8'), 'do not delete'); assert.ok(fs.existsSync(f.video));
});
test('невозможность восстановления оставляет проверенную копию и журнал для перезапуска', async t => {
  const f = fixture(t, true), p = await f.preview(); const unlink = fs.promises.unlink, open = fs.promises.open; let count = 0, restoring = false;
  const unlinkMock = t.mock.method(fs.promises, 'unlink', async function(p) { if (++count === 2) throw Error('delete refused'); return unlink.call(this, p); });
  f.svc.onTransfer = e => { if (e.phase === 'restoring') restoring = true; };
  const openMock = t.mock.method(fs.promises, 'open', async function(p, flags, ...args) { if (restoring && flags === 'wx' && p.startsWith(f.source)) throw Error('source offline'); return open.call(this, p, flags, ...args); });
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.equal(r.sourceRestored, false); assert.equal(f.svc.state.nightTransfers[0].status, 'needs-recovery');
  unlinkMock.mock.restore(); openMock.mock.restore();
  const restored = new Service({ dir: f.svc.dir }); const recovery = await restored.recoverNightTransfer(r.id); assert.equal(recovery.ok, true); assert.equal(fs.readFileSync(f.video, 'utf8'), 'movie content'); assert.equal(fs.readFileSync(f.sub, 'utf8'), 'subtitle content');
});
test('прерывание после удаления до записи пути восстанавливается без автоматического удаления', async t => {
  const f = fixture(t, true), p = await f.preview(); let persisted;
  f.svc.onTransfer = e => { if (e.phase === 'deleting') persisted = fs.readFileSync(f.svc.file, 'utf8'); };
  assert.equal((await f.svc.executeNightTransfer(p.token)).ok, true);
  fs.writeFileSync(f.svc.file, persisted); const restored = new Service({ dir: f.svc.dir });
  assert.equal(fs.existsSync(f.source), false); assert.equal(restored.state.nightTransfers[0].status, 'deleting');
  await restored.recoverNightTransfer(restored.state.nightTransfers[0].id);
  assert.equal(fs.readFileSync(f.video, 'utf8'), 'movie content'); assert.equal(restored.state.files.entry.path, f.source);
});
test('ошибка записи обновлённой библиотеки восстанавливает источник', async t => {
  const f = fixture(t), p = await f.preview(), save = f.svc.save.bind(f.svc); let once = false;
  t.mock.method(f.svc, 'save', () => { if (!once && f.svc.state.nightTransfers[0]?.status === 'completed') { once = true; throw Error('database disk full'); } return save(); });
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.equal(r.sourceRestored, true); assert.ok(fs.existsSync(f.source)); assert.equal(f.svc.state.files.entry.path, f.source); assert.equal(f.svc.state.files[f.target.toLowerCase()], undefined);
});
test('служебные папки, ссылки и вложенное назначение блокируются', async t => {
  for (const type of ['symlink', 'recycle', 'nested', 'root', 'other-entry']) {
    const f = fixture(t, true);
    if (type === 'symlink') fs.symlinkSync(f.video, path.join(f.source, 'linked.mkv'));
    if (type === 'recycle') fs.mkdirSync(path.join(f.source, '#recycle'));
    if (type === 'nested') { const d = path.join(f.source, 'today'); fs.mkdirSync(d); f.svc.state.folders[1].path = d; }
    if (type === 'root') f.svc.state.folders[0].path = f.source;
    if (type === 'other-entry') f.svc.state.files.other = { id: 'other', path: path.join(f.source, 'other.mkv'), filmKey: 'm2' };
    await assert.rejects(f.preview()); assert.ok(fs.existsSync(f.video));
  }
});
test('ссылки в пути к источнику и назначению не поддерживаются', async t => {
  for (const which of ['source', 'today']) {
    const f = fixture(t), link = path.join(f.root, 'link'); fs.symlinkSync(which === 'source' ? f.sourceRoot : f.today, link, 'dir');
    if (which === 'source') f.svc.state.files.entry.path = path.join(link, path.basename(f.source)); else f.svc.state.folders[1].path = link;
    await assert.rejects(f.preview(), /Ссылки/);
  }
});
test('сканирование и второй перенос не начинаются во время копирования', async t => {
  const f = fixture(t), first = await f.preview(), second = await f.preview(); let blocked;
  f.svc.onTransfer = e => { if (e.phase === 'copying' && !blocked) blocked = Promise.all([assert.rejects(f.svc.scanAll(), /переноса/), assert.rejects(f.svc.executeNightTransfer(second.token), /операции/)]); };
  assert.equal((await f.svc.executeNightTransfer(first.token)).ok, true); await blocked;
});
test('незавершённая копия не появляется как готовая в сканере', async t => {
  const f = fixture(t); const { MIN_FILM_BYTES } = require('../src/scanner');
  // Sparse output simulates an interrupted large movie without copying it.
  const fd = fs.openSync(f.target, 'w'); fs.ftruncateSync(fd, MIN_FILM_BYTES + 1); fs.closeSync(fd);
  f.svc.state.nightTransfers = [{ id: 'interrupted', status: 'copying', isFile: true, target: f.target, files: [{ target: f.target }] }];
  await f.svc.scanAll(f.today); assert.equal(Object.values(f.svc.state.files).some(e => e.path === f.target), false);
});

test('полный диск назначения не приводит к удалению исходника', async t => {
  const f = fixture(t), p = await f.preview(), open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async function(p, flags, ...args) {
    const h = await open.call(this, p, flags, ...args);
    if (flags === 'wx') h.write = async () => { const error = Error('No space left on device'); error.code = 'ENOSPC'; throw error; };
    return h;
  });
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.match(r.error, /space/); assert.equal(fs.readFileSync(f.source, 'utf8'), 'movie content'); assert.ok(fs.existsSync(f.sub));
});
test('копия, изменённая после проверки, не разрешает удаление источника', async t => {
  const f = fixture(t), p = await f.preview();
  f.svc.onTransfer = e => { if (e.phase === 'deleting') fs.writeFileSync(f.target, 'tampered after check'); };
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.ok(fs.existsSync(f.source)); assert.ok(fs.existsSync(f.sub));
});
test('отказ базы во всех записях после удаления не мешает восстановлению файлов', async t => {
  const f = fixture(t), p = await f.preview(), save = f.svc.save.bind(f.svc); let completed = false;
  t.mock.method(f.svc, 'save', () => { if (f.svc.state.nightTransfers[0]?.status === 'completed') completed = true; if (completed) throw Error('database offline'); return save(); });
  const r = await f.svc.executeNightTransfer(p.token); assert.equal(r.ok, false); assert.equal(r.sourceRestored, true); assert.equal(fs.readFileSync(f.source, 'utf8'), 'movie content'); assert.equal(fs.readFileSync(f.sub, 'utf8'), 'subtitle content'); assert.match(f.svc.state.nightTransfers[0].persistenceError, /offline/);
});
test('журнал нельзя закрыть до восстановления и ручного удаления оставленной копии', async t => {
  const f = fixture(t), p = await f.preview(); f.svc.onTransfer = e => { if (e.phase === 'verifying') fs.writeFileSync(f.target, 'broken'); };
  const r = await f.svc.executeNightTransfer(p.token);
  await assert.rejects(f.svc.dismissNightTransfer(r.id), /ещё существует/);
  await assert.rejects(f.preview(), /прежнюю запись/);
  fs.unlinkSync(f.target); fs.unlinkSync(path.join(f.today, path.basename(f.sub)));
  await f.svc.dismissNightTransfer(r.id); f.svc.onTransfer = null;
  assert.equal((await f.svc.executeNightTransfer((await f.preview()).token)).ok, true);
});
test('повторное сканирование после переноса сохраняет ручную связь, названия и субтитры', async t => {
  const { MIN_FILM_BYTES } = require('../src/scanner');
  for (const folder of [false, true]) {
    const f = fixture(t, folder), fd = fs.openSync(f.video, 'r+'); fs.ftruncateSync(fd, MIN_FILM_BYTES + 1); fs.closeSync(fd);
    f.svc.state.files = {}; await f.svc.scanAll();
    const entry = Object.values(f.svc.state.files).find(e => e.path === f.source);
    f.svc.chooseEntryFilm(entry.id, 'm1'); f.svc.setRenamePreference(entry.id, 'keep');
    const p = await f.svc.previewNightTransfer('night', 0, entry.id), result = await f.svc.executeNightTransfer(p.token);
    assert.equal(result.ok, true, result.error); await f.svc.scanAll();
    const moved = f.svc.state.files[f.target.toLowerCase()];
    assert.equal(moved.filmKey, 'm1'); assert.equal(moved.matchMethod, 'manual'); assert.equal(moved.renamePreference, 'keep'); assert.equal(moved.role, 'today'); assert.equal(moved.subs.state, 'ru');
    assert.equal(f.svc.filmEntries('m1').length, 1); assert.equal(f.svc.state.films.m1.userTitle, 'Личное имя');
  }
});
test('DVD: структура, все активные пути и ручная связь сохраняются после переноса и сканирования', async t => {
  const f = fixture(t, true); fs.unlinkSync(f.video); fs.unlinkSync(f.sub);
  const videoTs = path.join(f.source, 'VIDEO_TS'); fs.mkdirSync(videoTs);
  fs.writeFileSync(path.join(videoTs, 'VTS_01_1.VOB'), 'dvd data'); fs.writeFileSync(path.join(videoTs, 'VTS_01_0.IFO'), 'ifo');
  f.svc.state.files = {}; await f.svc.scanAll(); const entry = Object.values(f.svc.state.files)[0];
  assert.equal(entry.kind, 'dvd'); f.svc.chooseEntryFilm(entry.id, 'm1');
  const p = await f.svc.previewNightTransfer('night', 0, entry.id); assert.equal((await f.svc.executeNightTransfer(p.token)).ok, true);
  await f.svc.scanAll(); const moved = f.svc.state.files[f.target.toLowerCase()];
  assert.equal(moved.filmKey, 'm1'); assert.equal(moved.matchMethod, 'manual'); assert.equal(moved.video, path.join(f.target, 'VIDEO_TS')); assert.equal(moved.dvdParts[0], path.join(f.target, 'VIDEO_TS', 'VTS_01_1.VOB'));
});
test('утрата текущего источника при незавершённом переносе не позволяет затереть журнал импортом', async t => {
  const f = fixture(t); f.svc.state.nightTransfers = [{ status: 'deleting' }]; assert.throws(()=>f.svc.loadSeed({groups:[],near:[]}), /переносы/);
});

test('отсутствующий на диске путь другой записи библиотеки не затирается', async t => {
  const f = fixture(t); f.svc.state.files.stale = { id: 'stale', path: f.target, filmKey: 'm2', state: 'linked' };
  await assert.rejects(f.preview(), /занят записью/); assert.ok(fs.existsSync(f.source)); assert.equal(f.svc.state.files.stale.filmKey, 'm2');
});
test('неверная ночь, неподтверждённая связь и несколько папок «Сегодня» не разрешают перенос', async t => {
  const f = fixture(t); await assert.rejects(f.svc.previewNightTransfer('absent',0,'entry'), /подтверждённую/);
  f.svc.state.files.entry.forceReview=true; await assert.rejects(f.preview(), /подтверждённую/); delete f.svc.state.files.entry.forceReview;
  f.svc.state.folders.push({path:f.sourceRoot,role:'today'}); await assert.rejects(f.preview(), /ровно одну/);
});
test('просроченный токен не выполняет файловые операции', async t => {
  const f = fixture(t), p = await f.preview(); f.svc.transferPlans.get(p.token).expires = Date.now()-1;
  await assert.rejects(f.svc.executeNightTransfer(p.token), /устарел/); assert.ok(fs.existsSync(f.source)); assert.equal(fs.existsSync(f.target),false);
});
test('прогресс проверки учитывает чтение исходника и копии; отмена проверки сохраняет исходник', async t => {
  const f = fixture(t), p = await f.preview(); let checked=false, total, running;
  f.svc.onTransfer=e=>{ if(e.phase==='verifying'){checked=true;total=e.total;running=f.svc.getNightTransferProgress().running;f.svc.cancelNightTransfer();} };
  const r=await f.svc.executeNightTransfer(p.token); assert.equal(checked,true);assert.equal(total,p.bytes*2);assert.equal(running,true);assert.equal(r.ok,false);assert.ok(fs.existsSync(f.source));assert.ok(fs.existsSync(f.sub));assert.equal(f.svc.getNightTransferProgress().running,false);
});
test('исключение неполного VIDEO_TS происходит до распознавания DVD', async t => {
  const f = fixture(t), dvd = path.join(f.today,'VIDEO_TS'); fs.mkdirSync(dvd);fs.writeFileSync(path.join(dvd,'VTS_01_1.VOB'),'partial');
  f.svc.state.nightTransfers=[{id:'interrupted',status:'copying',isFile:false,target:dvd,files:[]}];
  await f.svc.scanAll(f.today); assert.equal(Object.values(f.svc.state.files).some(e=>e.path.startsWith(f.today)),false);
});

test('вся папка включает метаданные @eaDir Synology, но не открывает корзину', async t => {
  const f = fixture(t, true); const metadata=path.join(f.source,'@eaDir');fs.mkdirSync(metadata);fs.writeFileSync(path.join(metadata,'thumb.jpg'),'metadata');
  const p=await f.preview(); assert.ok(p.files.some(e=>e.source.includes('@eaDir')));
  assert.equal((await f.svc.executeNightTransfer(p.token)).ok,true);assert.equal(fs.readFileSync(path.join(f.target,'@eaDir','thumb.jpg'),'utf8'),'metadata');
});

test('каталог с расширением субтитров не считается внешним файлом субтитров', async t => {
  const f = fixture(t);const dir=path.join(f.sourceRoot,'Movie (2000).eng.srt');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'unrelated.txt'),'keep');
  const p=await f.preview();assert.equal(p.files.length,2);assert.equal(p.dirs.length,0);
  assert.equal((await f.svc.executeNightTransfer(p.token)).ok,true);assert.equal(fs.readFileSync(path.join(dir,'unrelated.txt'),'utf8'),'keep');
});
