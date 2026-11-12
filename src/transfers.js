'use strict';

// Copy first, independently hash both copies, journal before deleting anything.
// Never recursively remove a source tree: an unexpected/new file must survive.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { idOf } = require('./disks');
const SUBS = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt', '.idx', '.sup']);
const SYSTEM = new Set(['#recycle', '#snapshot', '$recycle.bin', 'system volume information', 'recycler']);
const clone = x => JSON.parse(JSON.stringify(x));
const inside = (p, root) => { const r = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase()); return !r || r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const stamp = s => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, dev: s.dev, mode: s.mode });
const same = (a, b) => ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(k => a[k] === b[k]);
const missing = async p => { try { await fs.promises.lstat(p); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };

async function safePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw Error('Нужен абсолютный путь.');
  if (p.split(/[\\/]+/).some(x => SYSTEM.has(x.toLowerCase()))) throw Error('Служебные папки и корзина не участвуют в переносе.');
  let cursor = path.resolve(p);
  for (;;) {
    const st = await fs.promises.lstat(cursor);
    if (st.isSymbolicLink()) throw Error(`Ссылки и junction не поддерживаются: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return fs.promises.realpath(p);
}

async function inventory(source, isFile) {
  const files = [], dirs = [];
  async function walk(p) {
    const st = await fs.promises.lstat(p);
    if (st.isSymbolicLink() || !st.isDirectory() && !st.isFile()) throw Error(`Ссылка или специальный файл: ${p}`);
    if (st.isFile()) files.push({ source: p, relative: path.relative(isFile ? path.dirname(source) : source, p), ...stamp(st) });
    else {
      dirs.push(p);
      for (const name of (await fs.promises.readdir(p)).sort()) {
        if (SYSTEM.has(name.toLowerCase())) throw Error(`В папке есть служебный каталог ${name}; перенос всей папки запрещён.`);
        await walk(path.join(p, name));
      }
    }
  }
  await walk(source);
  if (isFile) {
    const stem = path.basename(source, path.extname(source)).toLowerCase();
    for (const name of (await fs.promises.readdir(path.dirname(source))).sort()) {
      const base = name.slice(0, name.length - path.extname(name).length).toLowerCase();
      if (SUBS.has(path.extname(name).toLowerCase()) && (base === stem || base.startsWith(stem) && /^[._\s-]/.test(base.slice(stem.length)))) {
        const candidate = path.join(path.dirname(source), name);
        if (!(await fs.promises.lstat(candidate)).isDirectory()) await walk(candidate);
      }
    }
  }
  files.sort((a, b) => a.source.localeCompare(b.source));
  dirs.sort();
  if (!files.length) throw Error('В источнике нет файлов.');
  return { files, dirs };
}

function signature(plan) {
  return JSON.stringify({ nid: plan.nid, index: plan.index, entry: plan.entry, source: plan.source, target: plan.target, root: plan.root, isFile: plan.isFile, files: plan.files, dirs: plan.dirs });
}

async function makePlan(service, nid, index, entryId, executing = false) {
  if (service.scanning || service.running || service.transferBusy && !executing) throw Error('Дождись завершения текущего сканирования, импорта или переноса.');
  const night = (service.state.nights || []).find(n => n.id === nid);
  const slot = Number.isInteger(index) && night?.slots[index];
  const e = service.entries()[entryId];
  if (!slot || !e || e.filmKey !== slot.key || e.state !== 'linked' || e.forceReview) throw Error('Выбери подтверждённую копию фильма из этой ночи.');
  if (!['file', 'folder', 'dvd', 'bluray', 'parts'].includes(e.kind) || e.internalDiscRoot) throw Error('Эту запись нельзя перенести целиком. Выбери внешнюю папку фильма.');
  const today = service.folders().filter(f => f.role === 'today');
  if (today.length !== 1) throw Error('Назначь ровно одну папку с ролью «Сегодня» в разделе «Диски».');
  const source = await safePath(e.path), root = await safePath(today[0].path);
  if (!(await fs.promises.stat(root)).isDirectory()) throw Error('«Сегодня» должна быть папкой.');
  if (inside(source, root) || inside(root, source)) throw Error('Источник и «Сегодня» совпадают или вложены друг в друга.');
  const sources = service.folders().filter(f => f.role !== 'exclude' && inside(source, f.path));
  if (!sources.length || service.folders().some(f => inside(f.path, source))) throw Error('Нельзя переносить корень подключённого источника или файл вне подключённых папок.');
  if (service.folders().some(f => f.role === 'exclude' && (inside(source, f.path) || inside(f.path, source)))) throw Error('Перенос затрагивает исключённую папку.');
  if (Object.values(service.entries()).some(other => other.id !== e.id && inside(other.path, source))) throw Error('В папке есть другие записи библиотеки. Перенос всей папки запрещён.');
  const isFile = e.kind === 'file', st = await fs.promises.lstat(source);
  if (isFile ? !st.isFile() : !st.isDirectory()) throw Error('Тип источника изменился. Выполни сканирование.');
  const target = path.join(root, path.basename(source));
  const manifest = await inventory(source, isFile);
  const files = manifest.files.map(f => ({ ...f, target: isFile ? path.join(root, f.relative) : path.join(target, f.relative) }));
  const dirs = manifest.dirs.map(p => ({ source: p, target: path.join(target, path.relative(source, p)) }));
  const destinations = isFile ? files.map(f => f.target) : [target];
  for (const job of service.state.nightTransfers || []) {
    if (['completed', 'dismissed'].includes(job.status)) continue;
    const oldTargets = job.isFile ? job.files.map(f => f.target) : [job.target];
    const overlapsSource = job.source && (inside(source, job.source) || inside(job.source, source));
    const overlapsTarget = destinations.some(p => oldTargets.some(q => inside(p, q) || inside(q, p)));
    if (overlapsSource || overlapsTarget) throw Error('Сначала восстанови исходник и закрой прежнюю запись переноса в журнале.');
  }
  if (Object.values(service.entries()).some(other => destinations.some(p => inside(other.path, p) || inside(p, other.path)))) throw Error('Путь назначения занят записью библиотеки. Сначала проверь её в «Дисках».');
  const names = new Set((await fs.promises.readdir(root)).map(n => n.toLowerCase()));
  const conflicts = destinations.filter(p => names.has(path.basename(p).toLowerCase()));
  if (conflicts.length) throw Error(`Имя в «Сегодня» занято, перезапись запрещена: ${conflicts.join(', ')}`);
  const unique = new Set();
  for (const item of [...dirs, ...files]) {
    const key = idOf(item.target);
    if (unique.has(key)) throw Error('Имена различаются только регистром. На Windows перенос небезопасен.');
    unique.add(key);
  }
  // The record itself is kept, rather than rematched by title after moving.
  return { nid, index, entry: clone(e), source, root, target, isFile, files, dirs, bytes: files.reduce((n, f) => n + f.size, 0) };
}

function notify(service, job, phase, current = '', done = 0) {
  service.transferProgress = { id: job.id, nid: job.nid, phase, current, done, total: phase === 'verifying' ? job.bytes * 2 : job.bytes, files: job.files.length };
  const now = Date.now();
  if (service.onTransfer && (service.transferPhase !== phase || now - (service.transferNotified || 0) >= 100)) {
    service.transferPhase = phase; service.transferNotified = now;
    try { service.onTransfer(service.transferProgress); } catch { /* Closing the renderer must not abort file recovery. */ }
  }
}
function cancelled(service) { if (service.transferCancel) throw Error('Перенос отменён.'); }
async function hashFile(p, progress = () => {}) {
  const fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await fh.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    if (!before.isFile()) throw Error(`Не обычный файл: ${p}`);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size) throw Error(`Файл растёт во время чтения: ${p}`);
      hash.update(buffer.subarray(0, bytesRead)); progress(bytesRead);
    }
    if (total !== before.size || !same(stamp(before), stamp(await fh.stat()))) throw Error(`Файл изменился при чтении: ${p}`);
    return hash.digest('hex');
  } finally { await fh.close(); }
}
async function copyExclusive(file, progress = () => {}) {
  const input = await fs.promises.open(file.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let output;
  try {
    if (!same(file, stamp(await input.stat()))) throw Error(`Источник изменился: ${file.source}`);
    output = await fs.promises.open(file.target, 'wx', file.mode & 0o777);
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, null);
        if (!bytesWritten) throw Error('Не удалось записать копию.');
        written += bytesWritten;
      }
      size += bytesRead;
      if (size > file.size) throw Error(`Источник растёт во время копирования: ${file.source}`);
      hash.update(buffer.subarray(0, bytesRead)); progress(bytesRead);
    }
    if (size !== file.size || !same(file, stamp(await input.stat()))) throw Error(`Источник изменился во время копирования: ${file.source}`);
    await output.sync();
    await output.utimes(new Date(file.mtimeMs), new Date(file.mtimeMs));
    return hash.digest('hex');
  } finally { await output?.close(); await input.close(); }
}
async function checkManifest(job) {
  const fresh = await inventory(job.source, job.isFile);
  if (JSON.stringify(fresh.files) !== JSON.stringify(job.files.map(({ target, hash, copyStamp, ...f }) => f)) || JSON.stringify(fresh.dirs) !== JSON.stringify(job.dirs.map(d => d.source))) throw Error('Состав или содержимое источника изменились. Создай новый предпросмотр.');
}
async function relocated(job) {
  const move = p => p && inside(p, job.source) ? path.join(job.target, path.relative(job.source, p)) : p;
  const entry = { ...clone(job.entry), id: idOf(job.target), path: job.target, role: 'today', video: move(job.entry.video), dvdParts: job.entry.dvdParts?.map(move) };
  // Destination filesystem timestamp precision can differ from the source.
  // Store the destination facts so a rescan keeps the explicit association.
  if (['dvd', 'bluray'].includes(entry.kind)) entry.mtime = (await fs.promises.stat(job.target)).mtimeMs;
  else {
    const main = await fs.promises.stat(entry.video || job.target);
    if (['file', 'folder'].includes(entry.kind)) entry.size = main.size;
    const latest = job.files.filter(f => f.mtimeMs === job.entry.mtime);
    entry.mtime = latest.length ? Math.max(...await Promise.all(latest.map(async f => (await fs.promises.stat(f.target)).mtimeMs))) : main.mtimeMs;
  }
  return entry;
}

// Recovery is explicitly requested; a restart never resumes source deletion.
async function restoreSource(service, job) {
  job.status = 'restoring';
  job.sourceRestored = false;
  try { service.save(); } catch (e) { job.persistenceError = e.message; }
  notify(service, job, 'restoring');
  const errors = [];
  for (const d of job.dirs) {
    try {
      await safePath(path.dirname(d.source));
      if (await missing(d.source)) await fs.promises.mkdir(d.source);
      await safePath(d.source);
    } catch (e) { errors.push(e.message); }
  }
  for (const f of job.files) {
    try {
      await safePath(path.dirname(f.source));
      if (await missing(f.source)) {
        await safePath(f.target);
        if (!f.hash || await hashFile(f.target) !== f.hash) throw Error(`Нет проверенной копии для восстановления: ${f.target}`);
        const st = await fs.promises.lstat(f.target);
        await copyExclusive({ ...stamp(st), source: f.target, target: f.source });
        await fs.promises.utimes(f.source, new Date(f.mtimeMs), new Date(f.mtimeMs));
      }
      await safePath(f.source);
      if (f.hash && await hashFile(f.source) !== f.hash) throw Error(`Исходник изменён; автоматическая замена запрещена: ${f.source}`);
    } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw Error(errors.join('\n'));
  const moved = service.entries()[idOf(job.target)];
  if (moved?.transferId === job.id) delete service.entries()[idOf(job.target)];
  const facts = await relocated({ ...job, target: job.source, files: job.files.map(f => ({ ...f, target: f.source })) });
  const original = service.entries()[job.entry.id];
  if (!original) service.entries()[job.entry.id] = { ...facts, id: job.entry.id, role: job.entry.role };
  else if (original.filmKey === job.entry.filmKey && original.path === job.entry.path) {
    original.size = facts.size; original.mtime = facts.mtime;
  }
  job.status = 'failed'; job.sourceRestored = true;
  delete job.recoveryError;
  try { service.save(); } catch (e) { job.persistenceError = e.message; }
}

const transferMethods = {
  async previewNightTransfer(nid, index, entryId) {
    const plan = await makePlan(this, nid, index, entryId);
    this.transferPlans = this.transferPlans || new Map();
    // Tokens are single-use, server-side and short lived. Never accept a renderer-supplied manifest.
    for (const [key, p] of this.transferPlans) if (p.expires < Date.now()) this.transferPlans.delete(key);
    if (this.transferPlans.size >= 20) this.transferPlans.delete(this.transferPlans.keys().next().value);
    const token = randomUUID(); this.transferPlans.set(token, { plan, expires: Date.now() + 15 * 60 * 1000 });
    return { token, source: plan.source, target: plan.target, isFile: plan.isFile, bytes: plan.bytes, files: plan.files.map(f => ({ source: f.source, target: f.target, size: f.size })), dirs: plan.dirs.map(d => d.target), title: this.mustFilm(plan.entry.filmKey).userTitle || plan.entry.title };
  },
  getNightTransferProgress() { return { ...this.transferProgress, running: !!this.transferBusy && !['completed', 'failed'].includes(this.transferProgress?.phase) }; },
  cancelNightTransfer() {
    if (this.transferProgress && ['copying', 'verifying'].includes(this.transferProgress.phase)) this.transferCancel = true;
    return this.transferProgress || null;
  },
  async executeNightTransfer(token) {
    if (this.transferBusy || this.scanning || this.running) throw Error('Дождись завершения текущей операции.');
    const saved = this.transferPlans?.get(token); this.transferPlans?.delete(token);
    if (!saved || saved.expires < Date.now()) throw Error('Предпросмотр устарел. Создай его заново.');
    // Reserve before the next await, including preflight filesystem checks.
    this.transferBusy = true; this.transferCancel = false;
    this.transferProgress = { nid: saved.plan.nid, phase: 'preparing', done: 0, total: 0 };
    let job, deleting = false;
    try {
      const fresh = await makePlan(this, saved.plan.nid, saved.plan.index, saved.plan.entry.id, true);
      if (signature(fresh) !== signature(saved.plan)) throw Error('Источник или настройки изменились после предпросмотра. Создай новый предпросмотр.');
      job = { ...fresh, id: randomUUID(), status: 'copying', at: new Date().toISOString() };
      (this.state.nightTransfers || (this.state.nightTransfers = [])).push(job);
      this.save(); notify(this, job, 'copying');
      for (const d of job.dirs) { cancelled(this); await safePath(path.dirname(d.target)); await fs.promises.mkdir(d.target); }
      let copied = 0;
      for (const f of job.files) {
        cancelled(this); await safePath(path.dirname(f.target));
        f.hash = await copyExclusive(f, bytes => { cancelled(this); copied += bytes; notify(this, job, 'copying', f.source, copied); });
        this.save();
      }
      job.status = 'verifying'; this.save(); notify(this, job, 'verifying');
      let verified = 0;
      for (const f of job.files) {
        cancelled(this); await safePath(f.source); await safePath(f.target);
        const progress = p => bytes => { cancelled(this); verified += bytes; notify(this, job, 'verifying', p, verified); };
        if (await hashFile(f.source, progress(f.source)) !== f.hash || await hashFile(f.target, progress(f.target)) !== f.hash) throw Error(`Проверка SHA-256 не пройдена: ${f.source}`);
        f.copyStamp = stamp(await fs.promises.lstat(f.target));
      }
      await checkManifest(job); cancelled(this);
      // Persist complete hashes BEFORE unlink. A crash is recoverable from this journal.
      job.previousTask = this.state.nights.find(n => n.id === job.nid)?.tasks[`${job.index}:file`];
      job.status = 'deleting'; this.save(); deleting = true; notify(this, job, 'deleting');
      let deleted = 0;
      for (const f of job.files) {
        await safePath(f.source); await safePath(f.target);
        if (!same(f.copyStamp, stamp(await fs.promises.lstat(f.target)))) throw Error(`Копия изменилась перед удалением: ${f.target}`);
        if (!same(f, stamp(await fs.promises.lstat(f.source)))) throw Error(`Источник изменился перед удалением: ${f.source}`);
        await fs.promises.unlink(f.source);
        deleted += f.size; notify(this, job, 'deleting', f.source, deleted);
      }
      for (const d of [...job.dirs].reverse()) await fs.promises.rmdir(d.source);
      const entry = { ...await relocated(job), transferId: job.id };
      delete this.entries()[job.entry.id]; this.entries()[entry.id] = entry;
      const night = this.state.nights.find(n => n.id === job.nid);
      if (night?.slots[job.index]?.key === entry.filmKey) night.tasks[`${job.index}:file`] = true;
      job.status = 'completed'; job.completedAt = new Date().toISOString(); this.save();
      notify(this, job, 'completed', job.target, job.bytes);
      return { state: this.state, ok: true, id: job.id };
    } catch (error) {
      if (!job) throw error;
      job.error = error.message;
      if (deleting) {
        const night = this.state.nights.find(n => n.id === job.nid);
        if (night) { if (job.previousTask === undefined) delete night.tasks[`${job.index}:file`]; else night.tasks[`${job.index}:file`] = job.previousTask; }
        try { await restoreSource(this, job); }
        catch (restoreError) { job.status = 'needs-recovery'; job.recoveryError = restoreError.message; job.sourceRestored = false; }
      } else { job.status = 'failed'; job.sourceRestored = true; }
      // Partial/verified destinations stay visible in the journal, excluded from scanning.
      try { this.save(); } catch (e) { job.persistenceError = e.message; }
      notify(this, job, 'failed');
      return { state: this.state, ok: false, id: job.id, error: job.error, sourceRestored: job.sourceRestored };
    } finally { this.transferBusy = false; this.transferCancel = false; }
  },
  async dismissNightTransfer(id) {
    if (this.transferBusy || this.scanning || this.running) throw Error('Дождись завершения текущей операции.');
    const job = (this.state.nightTransfers || []).find(j => j.id === id);
    if (!job?.sourceRestored) throw Error('Сначала восстанови исходник.');
    for (const p of job.isFile ? job.files.map(f => f.target) : [job.target]) {
      if (!await missing(p)) throw Error(`Созданная копия ещё существует. Сначала проверь исходник и убери копию вручную: ${p}`);
    }
    job.status = 'dismissed'; this.save(); return this.state;
  },
  async recoverNightTransfer(id) {
    if (this.transferBusy || this.scanning || this.running) throw Error('Дождись завершения текущей операции.');
    const job = (this.state.nightTransfers || []).find(j => j.id === id);
    if (!job || ['completed', 'dismissed'].includes(job.status)) throw Error('Нет незавершённого переноса.');
    this.transferBusy = true;
    try {
      await restoreSource(this, job);
      notify(this, job, 'failed');
      return { state: this.state, ok: true };
    } catch (e) {
      job.status = 'needs-recovery'; job.sourceRestored = false; job.recoveryError = e.message; this.save();
      throw e;
    } finally { this.transferBusy = false; }
  },
};
module.exports = { transferMethods };
