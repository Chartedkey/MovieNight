'use strict';

const BASE = 'https://api.themoviedb.org/3';

class TmdbError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function createTmdb({ key, fetchImpl, language = 'ru-RU', minGapMs = 60, sleep, requestTimeoutMs = 20000 }) {
  const doFetch = fetchImpl || fetch;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bearer = /^eyJ/.test(key);
  let last = 0;

  async function fetchResponse(url, options) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const res = await doFetch(url, { ...options, signal: controller.signal });
          const data = res.ok ? await res.json() : null;
          return { res, data };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('TMDB request timed out'));
            controller.abort();
          }, requestTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(path, params = {}, attempt = 0) {
    const gap = last + minGapMs - Date.now();
    if (gap > 0) await wait(gap);
    last = Date.now();
    const url = new URL(BASE + path);
    Object.entries({ language, ...params }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    if (!bearer) url.searchParams.set('api_key', key);
    let res, data;
    try {
      ({ res, data } = await fetchResponse(url.toString(), {
        headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) },
      }));
    } catch (e) {
      if (attempt < 3) {
        await wait(1000 * (attempt + 1));
        return get(path, params, attempt + 1);
      }
      throw new TmdbError('network', 'TMDB не отвечает. Проверь интернет или доступ к сервису.');
    }
    if (res.status === 401) throw new TmdbError('auth', 'TMDB не принял ключ. Проверь его в настройках аккаунта.');
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await wait(1500 * (attempt + 1));
      return get(path, params, attempt + 1);
    }
    if (res.status === 404) throw new TmdbError('missing', 'В TMDB нет такой записи.');
    if (!res.ok) throw new TmdbError('http', `TMDB ответил ошибкой ${res.status}.`);
    return data;
  }

  return {
    get,
    ping: () => get('/configuration'),
    details: (id) => get(`/movie/${id}`, { append_to_response: 'credits,translations,alternative_titles' }),
    credits: (personId) => get(`/person/${personId}/movie_credits`),
    searchMovie: (query) => get('/search/movie', { query, include_adult: 'false' }),
    searchPerson: (query) => get('/search/person', { query, include_adult: 'false' }),
  };
}

module.exports = { createTmdb, TmdbError };
