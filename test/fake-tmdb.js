'use strict';
// Маленькая подмена TMDB для тестов: отвечает из заранее заданных фильмов.
function fakeTmdb(movies, people = {}) {
  const calls = [];
  const byId = new Map(movies.map((m) => [m.id, m]));
  const view = (m) => ({ id: m.id, title: m.title, original_title: m.original_title || m.title, release_date: `${m.year}-01-01`, vote_count: m.votes ?? 100, overview: '', video: false });
  return {
    calls,
    get: async (path, p = {}) => {
      calls.push(path);
      const q = String(p.query || '').toLowerCase().replace(/ё/g, 'е');
      const hit = movies.filter((m) => m.title.toLowerCase().replace(/ё/g, 'е').includes(q) && (!p.year || m.year === Number(p.year)));
      return { results: hit.map(view) };
    },
    ping: async () => ({}),
    details: async (id) => {
      calls.push(`details:${id}`);
      const m = byId.get(id);
      return { ...view(m), runtime: m.runtime ?? 100, genres: [{ id: 18, name: 'драма' }], production_countries: [{ name: 'Франция' }], status: 'Released', popularity: 5, vote_average: m.vote ?? 7, poster_path: null, credits: { crew: (m.directors || []).map((d) => ({ id: d[0], name: d[1], job: 'Director' })).concat([{ id: 999, name: 'Сценарист', job: 'Writer' }]) }, translations: { translations: [] } };
    },
    credits: async (pid) => ({ crew: people[pid] || [] }),
    searchMovie: async (q) => ({ results: movies.filter((m) => m.title.toLowerCase().includes(q.toLowerCase())).map(view) }),
    searchPerson: async () => ({ results: [] }),
  };
}
module.exports = { fakeTmdb };
