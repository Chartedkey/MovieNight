'use strict';
const fs = require('fs');
const path = require('path');

const VIDEO = new Set(['.mkv', '.avi', '.mp4', '.m4v', '.mov', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.vob', '.flv', '.webm', '.iso', '.divx']);
const SUBS = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt', '.idx', '.sup']);
const SKIP_DIRS = new Set(['#recycle', '@eadir', '$recycle.bin', 'system volume information', '#snapshot', '.ds_store', 'recycler']);
const BONUS_DIR = /^(sample|samples|extras?|bonus(es)?|featurettes?|trailers?|behind the scenes|deleted scenes|бонус(ы)?|доп(олнительно|\.?\s*материалы)?|трейлеры?)$/i;
const BONUS_FILE = /(^|[\s._\-[(])(sample|trailer|featurette|трейлер|семпл)([\s._\-\])]|$)/i;
const EPISODE = /(?:^|[\s._\-[(])(?:s\d{1,2}[\s._-]?e\d{1,3}|\d{1,2}x\d{2,3}|сезон[\s._-]*\d+|серия[\s._-]*\d+|\d+[\s._-]*(?:серия|сезон)|season[\s._-]*\d+|episode[\s._-]*\d+)/i;
const SEASON_DIR = /^(сезон|season|s)[\s._-]*\d+$|^\d+[\s._-]*сезон$/i;
const PART = /(?:^|[\s._\-[(])(?:cd|dvd|disc|disk|part|pt|часть|диск)[\s._-]*(\d)(?:[\s._\-\])]|$)/i;
const TAGS = /[\s._\-[(]+(?:\d{3,4}p|bdremux|l[1-9](?=[\s._\-\])]|$)|bdrip|brrip|dvdrip|webrip|web-dl|hdrip|hdtv|bluray|blu-ray|remux|x26[45]|h\.?26[45]|hevc|xvid|divx|ac3|dts|aac|rus|eng|dub|mvo|avo|криттерион|criterion|director'?s cut|режисс[её]рская).*$/i;
const DVD_TITLE_VOB = /^VTS_\d{2}_[1-9]\.VOB$/i;
const DVD_VOB = /^(?:VTS_\d{2}_[0-9]|VIDEO_TS)\.VOB$/i;
const MIN_FILM_BYTES = 100 * 1024 * 1024;

function parseName(raw, isFile) {
  let s = String(raw);
  if (isFile) s = s.slice(0, s.length - path.extname(s).length);
  if (!/\s/.test(s) && /[._]/.test(s)) s = s.replace(/[._]+/g, ' ');
  s = s.replace(TAGS, '').trim();
  const now = new Date().getFullYear() + 1;
  const m = s.match(/^(.*\S)[\s._,\-]*[([]?\b((?:18|19|20)\d\d)\b[)\]]?[\s._\-]*(.*)$/);
  if (m && Number(m[2]) <= now && !m[3]) {
    const title = m[1].replace(/[\s._,\-([]+$/, '').trim();
    if (title) return { title, year: Number(m[2]) };
  }
  return { title: s.replace(PART, '').replace(/[\s._,\-([]+$/, '').trim() || s, year: null };
}

async function list(dir) {
  return fs.promises.readdir(dir, { withFileTypes: true });
}

async function fileInfo(p) {
  const st = await fs.promises.stat(p);
  return { size: st.size, mtime: st.mtimeMs };
}

async function dirSize(dir) {
  let size = 0;
  for (const e of await list(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) size += await dirSize(p);
    else if (e.isFile()) size += (await fileInfo(p)).size;
  }
  return size;
}

// На DVD фильм лежит в самом большом наборе VTS_xx.
async function discMain(videoTs) {
  const sets = new Map();
  const files = [];
  for (const e of await list(videoTs)) {
    if (e.isFile() && DVD_VOB.test(e.name)) files.push(path.join(videoTs,e.name));
    const m = e.name.match(/^VTS_(\d\d)_[1-9]\.VOB$/i);
    if (m && e.isFile()) sets.set(m[1], (sets.get(m[1]) || 0) + (await fileInfo(path.join(videoTs, e.name))).size);
  }
  let best = null;
  sets.forEach((v, k) => { if (!best || v > best.size) best = { set: k, size: v }; });
  return best ? { ...best, files } : null;
}

function sidecars(names) {
  return names.filter((n) => SUBS.has(path.extname(n).toLowerCase()));
}

// Auxiliary folders are allowed beside a DVD. Inspect their contents instead of
// rejecting every unfamiliar directory name or grouping another movie silently.
async function findSeparateVideo(dir, entries, ctx, ignoreDvdParts = false) {
  for (const e of entries) {
    if (!e.isFile() || !VIDEO.has(path.extname(e.name).toLowerCase()) || BONUS_FILE.test(e.name) || (ignoreDvdParts && DVD_VOB.test(e.name))) continue;
    const p = path.join(dir,e.name);
    try {
      if ((await fileInfo(p)).size>=MIN_FILM_BYTES) return { reason:'video',path:p };
    } catch (err) {
      ctx.errors.push(p);
      return { reason:'unreadable',path:p };
    }
  }
  for (const e of entries) {
    const p = path.join(dir,e.name);
    if (!e.isDirectory() || SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('.') || BONUS_DIR.test(e.name) || e.name.toLowerCase()==='audio_ts' || ctx.excluded.has(p.toLowerCase())) continue;
    let children;
    try { children = await list(p); }
    catch (err) { ctx.errors.push(p); return {reason:'unreadable',path:p}; }
    if (ctx.onProgress) ctx.onProgress({dirs:ctx.dirs,found:ctx.out.length,current:p});
    const found = await findSeparateVideo(p,children,ctx);
    if (found) return found;
  }
  return null;
}

async function scanDir(dir, ctx, isRoot) {
  if (ctx.shouldStop && ctx.shouldStop()) return;
  let entries;
  try {
    entries = await list(dir);
    entries = entries.filter(e => !ctx.excluded.has(path.join(dir, e.name).toLowerCase()));
  } catch (e) {
    if (isRoot) throw e;
    ctx.errors.push(dir);
    return;
  }
  ctx.dirs += 1;
  if (ctx.onProgress) ctx.onProgress({ dirs: ctx.dirs, found: ctx.out.length, current: dir });
  const name = path.basename(dir) || dir;
  const lowerNames = new Map(entries.map((e) => [e.name.toLowerCase(), e]));

  const wrappedDvd = lowerNames.get('video_ts')?.isDirectory();
  const hasDvdParts = !wrappedDvd && entries.some(e=>e.isFile() && DVD_TITLE_VOB.test(e.name));
  const dvdBlocker = hasDvdParts ? await findSeparateVideo(dir,entries,ctx,true) : null;
  const flatDvd = hasDvdParts && !dvdBlocker;
  const disc = (wrappedDvd || flatDvd) ? 'dvd' : lowerNames.get('bdmv')?.isDirectory() ? 'bluray' : null;
  if (disc) {
    const video = wrappedDvd ? path.join(dir,lowerNames.get('video_ts').name) : dir;
    const main = disc==='dvd' ? await discMain(video) : null;
    const internalDiscRoot = disc==='dvd' && name.toLowerCase()==='video_ts';
    const displayName = internalDiscRoot ? path.basename(path.dirname(dir)) : name;
    ctx.out.push({ kind: disc, path: dir, name: displayName, ...parseName(displayName, false), size: await dirSize(dir), mainSet: main ? main.set : null, dvdParts: main?.files || [], internalDiscRoot, mtime: (await fs.promises.stat(dir)).mtimeMs, video, sidecars: flatDvd ? sidecars(entries.filter(e=>e.isFile()).map(e=>e.name)) : [] });
    return;
  }

  const files = [];
  const subdirs = [];
  for (const e of entries) {
    if (ctx.excluded.has(path.join(dir, e.name).toLowerCase())) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.') && !ctx.excluded.has(path.join(dir, e.name).toLowerCase())) subdirs.push(e.name);
    } else if (e.isFile()) files.push(e.name);
  }
  const subs = sidecars(files);
  const videos = [];
  for (const f of files) {
    if (!VIDEO.has(path.extname(f).toLowerCase())) continue;
    const info = await fileInfo(path.join(dir, f));
    videos.push({ file: f, ...info });
  }
  const main = videos.filter((v) => !BONUS_FILE.test(v.file) && v.size >= MIN_FILM_BYTES);
  const seasonDirs = subdirs.filter((d) => SEASON_DIR.test(d));
  const episodes = main.filter((v) => EPISODE.test(v.file));
  const seriesLike = !hasDvdParts && !isRoot && (seasonDirs.length > 0 || episodes.length >= 2 || looksLikeSeries(main));

  if (seriesLike) {
    ctx.out.push({ kind: 'series', path: dir, name, ...parseName(name, false), size: await dirSize(dir), mtime: 0, count: main.length, sidecars: [] });
    return;
  }

  const realSubdirs = subdirs.filter((d) => !BONUS_DIR.test(d));
  const parts = main.filter((v) => PART.test(v.file));
  if (main.length === 1 && !isRoot && !hasDvdParts) {
    const v = main[0];
    ctx.out.push({ kind: 'folder', path: dir, file: v.file, name, ...parseName(name, false), size: v.size, mtime: v.mtime, video: path.join(dir, v.file), sidecars: subs });
  } else if (main.length >= 2 && parts.length === main.length && !isRoot && !hasDvdParts) {
    ctx.out.push({ kind: 'parts', path: dir, name, ...parseName(name, false), size: main.reduce((a, v) => a + v.size, 0), mtime: Math.max(...main.map((v) => v.mtime)), video: path.join(dir, parts[0].file), sidecars: subs });
  } else {
    for (const v of main) {
      if (EPISODE.test(v.file)) {
        ctx.out.push({ kind: 'series', path: path.join(dir, v.file), name: v.file, ...parseName(v.file, true), size: v.size, mtime: v.mtime, count: 1, sidecars: [] });
        continue;
      }
      const base = v.file.slice(0, v.file.length - path.extname(v.file).length).toLowerCase();
      ctx.out.push({ kind: 'file', dvdGroupingBlocker: DVD_VOB.test(v.file) ? dvdBlocker : null, path: path.join(dir, v.file), file: v.file, name: v.file, ...parseName(v.file, true), size: v.size, mtime: v.mtime, video: path.join(dir, v.file), sidecars: subs.filter((s) => s.toLowerCase().startsWith(base)) });
    }
  }
  for (const d of realSubdirs) await scanDir(path.join(dir, d), ctx, false);
}

// Много файлов почти одного размера с номерами в именах.
function looksLikeSeries(main) {
  if (main.length < 4) return false;
  const sizes = main.map((v) => v.size).sort((a, b) => a - b);
  const numbered = main.filter((v) => /\d/.test(v.file)).length;
  return sizes[sizes.length - 1] <= sizes[0] * 1.8 && numbered === main.length;
}

async function scanFolder(root, opts = {}) {
  const ctx = { out: [], errors: [], dirs: 0, excluded: new Set((opts.exclude || []).map((x) => x.toLowerCase().replace(/[\\/]+$/, ''))), onProgress: opts.onProgress, shouldStop: opts.shouldStop };
  await scanDir(root, ctx, true);
  return { entries: ctx.out, errors: ctx.errors };
}

// Языки субтитров на DVD записаны в служебном файле VTS_xx_0.IFO.
function parseIfoSubtitles(buf) {
  if (buf.length < 0x256 + 6 || buf.toString('latin1', 0, 12) !== 'DVDVIDEO-VTS') return null;
  const n = Math.min(buf.readUInt16BE(0x254), 32);
  const langs = [];
  for (let i = 0; i < n; i++) {
    const o = 0x256 + i * 6;
    if (o + 6 > buf.length) break;
    const code = buf.toString('latin1', o + 2, o + 4).replace(/[^a-zA-Z]/g, '').toLowerCase();
    langs.push(code || 'und');
  }
  return langs;
}

const isRu = (l) => /^(ru|rus|russian|русск)/i.test(String(l || ''));

function sidecarLang(name) {
  const m = name.toLowerCase().match(/(?:^|[\s._\-[(])(rus|ru|russian|рус|русские|eng|en|english|fre|fr|ger|de|spa|es|ita|it|jpn|ja|kor|ko|chi|zh)(?:[\s._\-\])]|$)/);
  if (m) return m[1];
  return /[а-яё]/i.test(name) ? 'ru' : 'und';
}

// Итог для карточки: русские, на другом языке или не найдены.
function subtitleSummary(embedded, sidecarNames) {
  const langs = [...(embedded || []), ...(sidecarNames || []).map(sidecarLang)];
  if (langs.some(isRu)) return { state: 'ru', langs };
  if (langs.length) return { state: 'other', langs };
  return { state: 'none', langs };
}

module.exports = { scanFolder, parseName, parseIfoSubtitles, subtitleSummary, sidecarLang, isRu, MIN_FILM_BYTES };
