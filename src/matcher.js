'use strict';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]+/g, ' ')
    .trim();
}

function yearOf(c) {
  const y = parseInt(String(c.release_date || '').slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function score(title, year, c) {
  const want = norm(title);
  const names = [c.title, c.original_title].map(norm);
  let s = 0;
  if (names.includes(want)) s += 60;
  else if (names.some((n) => n && want && (n.includes(want) || want.includes(n)))) s += 25;
  const cy = yearOf(c);
  if (year && cy) {
    const d = Math.abs(year - cy);
    s += d === 0 ? 40 : d === 1 ? 25 : -20;
  } else if (!year) {
    s += 10;
  }
  s += Math.min(5, Math.log10(1 + (c.vote_count || 0)));
  return Math.round(s * 10) / 10;
}

function rank(title, year, results) {
  const seen = new Set();
  return (results || [])
    .filter((c) => !c.video && !seen.has(c.id) && seen.add(c.id))
    .map((c) => ({
      id: c.id,
      title: c.title,
      originalTitle: c.original_title,
      year: yearOf(c),
      overview: c.overview || '',
      score: score(title, year, c),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

// Уверены, только если название совпало, год подтвердился и второй кандидат заметно хуже.
function isConfident(cands, year) {
  if (!cands.length) return false;
  const [a, b] = cands;
  const threshold = year ? 85 : 999;
  return a.score >= threshold && (!b || a.score - b.score >= 15);
}

async function searchFilm(tmdb, title, year) {
  const params = { query: title, include_adult: 'false' };
  let results = [];
  if (year) {
    const r = await tmdb.get('/search/movie', { ...params, year });
    results = r.results || [];
  }
  const noYearStrong = results.some((c) => score(title, year, c) >= 85);
  if (!noYearStrong) {
    const r = await tmdb.get('/search/movie', params);
    results = results.concat(r.results || []);
  }
  return rank(title, year, results);
}

module.exports = { norm, yearOf, score, rank, isConfident, searchFilm };
