'use strict';
const { parseName } = require('./scanner');

const hasRussian = (s) => /[А-Яа-яЁё]/u.test(s || '');
const releaseNoise = (s) => /(?:^|[\s._()[\]-])(?:bdremux|bdrip|bluray|blu-ray|remux|dvdrip|webrip|web-dl|\d{3,4}p|l\d|x26[45]|hevc)(?=$|[\s._()[\]-])/i.test(s || '');

function diskTitle(raw, year) {
  let title = parseName(raw || '', false).title;
  if (hasRussian(title)) title = title.replace(/\s*\([^)]*[A-Za-z][^)]*\)\s*$/u, '').trim();
  return withoutYear(title, year);
}
function withoutYear(title, year) {
  // Strip a repeated suffix for this film's year, not a number that belongs to its title.
  const suffix = new RegExp(`\\s*\\(${year}\\)\\s*$`);
  let out = String(title || '').trim();
  while (suffix.test(out)) out = out.replace(suffix, '').trim();
  return out;
}
function renameTitle(f, e) {
  const raw = f.userTitle || e.title || '';
  const fromDisk = f.titleSource === 'disk' || (!f.titleSource && releaseNoise(raw));
  let title;
  if (f.userTitle && !fromDisk) title = withoutYear(f.userTitle, f.year);
  else {
    const local = diskTitle(raw || e.title, f.year);
    const canonical = f.tmdbTitle || '';
    title = hasRussian(canonical) ? canonical : hasRussian(local) ? local : canonical || local || f.originalTitle;
    title = withoutYear(title, f.year);
  }
  return String(title || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
}
module.exports = { renameTitle };
