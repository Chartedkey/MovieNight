'use strict';
const $app = document.getElementById('app');
const bridge = window.api || { call: async () => { throw new Error('Не загрузился мост к программе (preload).'); }, onProgress() {}, onUpdate() {} };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ui = { screen: 'library', libraryLetter: 'all', libraryNeeds: false, q: '', shown: 40, modal: null, menu: null, toast: null, progress: null, version: '', update: null, reviewQ: {}, reviewResults: {}, busy: false, error: null, hasKey: false, state: null, review: [], reviewShown: 12, reviewPeople: {}, reviewNote: {}, candInfo: {}, candLoading: false, rescue: null, diskTab: 'folders', scan: null, orphanSearch: {}, orphanQ: {}, orphanShown: 12, dups: [], plan: [], planFailed: [] };
const actions = {};
let actionSeq = 0;

function on(fn) { const id = `a${++actionSeq}`; actions[id] = fn; return id; }
const titleOf = (f) => f.userTitle || f.tmdbTitle || f.originalTitle || 'Без названия';
const COUNTRY_RU = { 'United States of America': 'США', 'United Kingdom': 'Великобритания', France: 'Франция', Germany: 'Германия', Italy: 'Италия', Spain: 'Испания', Japan: 'Япония', 'South Korea': 'Южная Корея', China: 'Китай', 'Hong Kong': 'Гонконг', Taiwan: 'Тайвань', India: 'Индия', Iran: 'Иран', Russia: 'Россия', 'Soviet Union': 'СССР', Canada: 'Канада', Australia: 'Австралия', 'New Zealand': 'Новая Зеландия', Netherlands: 'Нидерланды', Belgium: 'Бельгия', Denmark: 'Дания', Sweden: 'Швеция', Norway: 'Норвегия', Finland: 'Финляндия', Ireland: 'Ирландия', Austria: 'Австрия', Switzerland: 'Швейцария', Poland: 'Польша', Czechoslovakia: 'Чехословакия', 'Czech Republic': 'Чехия', Hungary: 'Венгрия', Romania: 'Румыния', Greece: 'Греция', Turkey: 'Турция', Israel: 'Израиль', Mexico: 'Мексика', Brazil: 'Бразилия', Argentina: 'Аргентина', Yugoslavia: 'Югославия', Serbia: 'Сербия', Portugal: 'Португалия', Thailand: 'Таиланд', Iceland: 'Исландия' };
const countryRu = (c) => COUNTRY_RU[c] || c;
const posterHtml = (path, big) => (path ? `<img class="poster ${big ? 'big' : ''}" loading="lazy" alt="" src="https://image.tmdb.org/t/p/${big ? 'w185' : 'w92'}${esc(path)}">` : `<div class="noposter ${big ? 'big' : ''}">нет постера</div>`);
const gb = (n) => (n >= 1e9 ? `${(n / 1073741824).toFixed(1)} ГБ` : `${Math.round(n / 1048576)} МБ`);
const kindName = { dvd: 'DVD', bluray: 'Blu-ray', parts: 'Несколько частей', folder: 'Файл в папке', file: 'Файл', series: 'Сериал' };
function allEntries() { return Object.values((ui.state && ui.state.files) || {}); }
function fileIndex() {
  const m = new Map();
  allEntries().forEach((e) => { if (e.filmKey && e.state === 'linked') { if (!m.has(e.filmKey)) m.set(e.filmKey, []); m.get(e.filmKey).push(e); } });
  return m;
}
function diskTags(f) {
  const hasFolders = (ui.state.folders || []).some((x) => x.role !== 'exclude');
  if (!hasFolders) return '';
  const list = ui.files.get(f.key) || [];
  if (!list.length) return `<span class="tag bad">${ui.state.allConnected ? 'Нужно скачать' : 'На подключённых дисках нет'}</span>`;
  const today = list.some((e) => e.role === 'today');
  const subsOf = list.map((e) => e.subs).filter(Boolean);
  const best = subsOf.find((x) => x.state === 'ru') || subsOf.find((x) => x.state === 'other') || subsOf[0];
  const sub = !best ? '' : best.state === 'ru' ? '<span class="tag gold">Русские субтитры</span>' : best.state === 'other' ? `<span class="tag">Субтитры: ${esc(best.langs.slice(0, 3).join(', '))}</span>` : '<span class="tag bad">Субтитров не нашли</span>';
  return `<span class="tag ${today ? 'gold' : ''}" title="${esc(list[0].path)}">${today ? 'В «Сегодня»' : 'На диске'}${list.length > 1 ? ` · копий: ${list.length}` : ''}</span>${sub}`;
}
const filmLine = (f) => `${esc(titleOf(f))}${f.year ? ` (${f.year})` : ''}`;
const filmMeta = (f) => [f.runtime ? `${f.runtime} мин` : null, (f.genres || []).slice(0, 2).join(', ') || null, (f.countries || []).slice(0, 1).map(countryRu)[0] || null].filter(Boolean).map(esc).join(' · ');

async function call(method, ...args) {
  try {
    return await bridge.call(method, ...args);
  } catch (e) {
    say(String(e.message || e).replace(/^Error invoking remote method 'api': (Error: )?/, ''));
    throw e;
  }
}
function say(text, action = null) { ui.toastAction = action; ui.toast = text; render(); clearTimeout(say.t); say.t = setTimeout(() => { ui.toast = null; render(); }, 3500); }
async function refresh() { ui.state = await call('getState'); render(); }
async function doState(method, ...args) { const r = await call(method, ...args); ui.state = r.state || r; ui.menu = null; render(); return r; }

function screenGate() {
  const s = ui.state;
  if (!ui.hasKey) return setupKey();
  const job = s.job;
  if (!job && !Object.keys(s.films).length) return setupSeed();
  if (job && !['review', 'done'].includes(job.phase)) return importing();
  return null;
}

function setupKey() {
  return `<div class="center"><img class="logo" src="logo.png" alt="Movie Night"><h1>Подключим TMDB</h1><div class="sub">Вставь ключ API или токен доступа из настроек своего аккаунта TMDB. Он хранится только на этом компьютере, в зашифрованном виде.</div><input id="key" class="field wide" type="password" autocomplete="off" aria-label="Ключ TMDB" placeholder="Ключ TMDB">${ui.error ? `<div class="error">${esc(ui.error)}</div>` : ''}<button class="btn primary" data-a="${on(async () => {
    const v = document.getElementById('key').value;
    ui.error = null; ui.busy = true; render();
    try { await bridge.call('setKey', v); ui.hasKey = true; } catch (e) { ui.error = String(e.message || e).replace(/^.*?Error: /, ''); }
    ui.busy = false; render();
  })}" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Проверяю…' : 'Проверить и сохранить'}</button></div>`;
}

function setupSeed() {
  return `<div class="center"><img class="logo" src="logo.png" alt="Movie Night"><h1>Загрузим твой список</h1><div class="sub">Выбери файл movie-night-seed.json. В нём фильмы из таблицы и список на ближайший просмотр. Отметки из таблицы не используются.</div><button class="btn primary" data-a="${on(async () => { if (await call('pickSeed')) { await refresh(); startImport(); } })}">Выбрать файл</button></div>`;
}

async function startImport() {
  ui.progress = await call('progress');
  render();
  await bridge.call('runImport');
  ui.review = await call('reviewList');
  ui.progress = await call('progress');
  await refresh();
  maybeRescue();
}
function maybeRescue() {
  if (ui.state.job && ui.state.job.phase === 'review' && !ui.state.rescueDone && ui.hasKey) runRescue();
}

function importing() {
  const p = ui.progress || {};
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const names = { films: 'Ищу фильмы в TMDB', groups: 'Проверяю режиссёров по строкам таблицы', near: 'Разбираю список «Ближайшие»', 'near-done': 'Завершаю' };
  const job = ui.state.job;
  const err = job && job.error;
  return `<div class="center"><img class="logo" src="logo.png" alt="Movie Night"><h1>Импорт</h1><div class="sub">${esc(names[p.phase] || names[job.phase] || '')}: ${p.done || 0} из ${p.total || job.items.length}. Можно закрыть программу: она продолжит с этого места.</div><div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div><div class="sub">Распознано сразу: ${p.auto || 0}. Спорных на этом этапе: ${p.review || 0}.</div>${err ? `<div class="error">${esc(err.message)}</div>` : ''}<div class="row">${p.running ? `<button class="btn" data-a="${on(() => call('stopImport'))}">Пауза</button>` : `<button class="btn primary" data-a="${on(startImport)}">${job.cursor ? 'Продолжить' : 'Начать'}</button>`}</div></div>`;
}

function navHtml() {
  const s = ui.state;
  const films = Object.values(s.films);
  const review = ui.review.length;
  const pending = films.filter((f) => f.pending || f.moveTask).length + (s.nights||[]).reduce((sum,n)=>sum+n.slots.filter(x=>!x.result).length,0);
  const items = [['library', 'Библиотека', 0], ...(review ? [['review', 'Спорные строки', review]] : []), ['near', 'Ближайшие', s.near.length], ['rewatch', 'Пересмотреть', films.filter((f) => f.rewatch).length], ['morning', 'Утренний разбор', pending], ['download', 'Скачать', downloadList().length], ['disks', 'Диски', allEntries().filter((e) => e.state === 'orphan').length + Object.keys(s.lost || {}).length], ['night', 'Собрать ночь', 0]];
  return `<nav class="side" aria-label="Разделы"><img class="logo" src="logo.png" alt="Movie Night">${items.map((n) => `<button class="nav ${ui.screen === n[0] ? 'on' : ''}" ${n[3] ? 'disabled title="Следующий этап"' : ''} data-a="${on(async () => { ui.screen = n[0]; if (n[0] === 'review') ui.review = await call('reviewList'); render(); if (n[0] === 'review') loadCandInfo(); if (n[0] === 'disks') loadDiskExtras(); })}"><span>${n[1]}</span>${n[2] ? `<span class="badge">${n[2]}</span>` : n[3] ? '<span class="sub" style="font-size:11px">скоро</span>' : ''}</button>`).join('')}<div class="ver">Версия ${esc(ui.version)}${ui.update ? `<br>${ui.update.state === 'ready' ? `<button class="mini on" data-a="${on(() => call('installUpdate'))}">Установить ${esc(ui.update.version)}</button>` : `Загружается ${esc(ui.update.version)}`}` : ''}</div></nav>`;
}

function directorNames(d) {
  return [d.name, d.userName, d.tmdbName, d.sortSurname, ...(d.aliases || [])].filter(Boolean);
}
function nearFilmsForDirector(id) {
  const keys = new Set((ui.state.near || []).flatMap(e=>e.ids));
  return [...keys].map(k=>ui.state.films[k]).filter(f=>f && (String(f.dir)===String(id)||(f.directorIds||[]).some(d=>String(d)===String(id))));
}
function nearFilmTag(f) {
  return (ui.state.near || []).some(e=>e.ids.includes(f.key)) ? '<span class="tag gold">В «Ближайших»</span>' : '';
}
function nearDirectorSummary(id, exclude = null) {
  const films = nearFilmsForDirector(id).filter(f=>f.key!==exclude);
  return films.length ? `<div class="sub" style="margin-top:8px">${exclude?'Другие фильмы режиссёра в «Ближайших»':'В «Ближайших»'}: ${films.map(f=>`${esc(titleOf(f))}${f.year?' ('+f.year+')':''}`).join(' · ')}</div>` : '';
}

function filmRow(f, extra = '') {
  return `<div class="film" data-film="${f.key}"><div class="fwrap">${posterHtml(f.poster)}<div><div class="ftitle">${filmLine(f)}</div><div class="fmeta">${filmMeta(f)}</div></div></div><div class="row">${nearFilmTag(f)}${diskTags(f)}${extra}<button class="mini" aria-label="Ещё действия" data-menu="${f.key}">Ещё</button></div></div>`;
}

function directorSortKey(d) {
  const name = String(d.name || '').trim();
  return ui.state.librarySort === 'surname' ? (d.sortSurname || name.split(/\s+/).pop() || name) : name;
}
function directorLetter(d) {
  const first = directorSortKey(d).replace(/^[^\p{L}]+/u, '').charAt(0).toUpperCase().replace('Ё','Е');
  return /^[А-Я]$/.test(first) ? first : /^[A-Z]$/.test(first) ? 'latin' : 'other';
}
function libraryControls() {
  const mode = ui.state.librarySort || 'name';
  const letters = [['all','Все'], ...Array.from('АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', x=>[x,x]), ['latin','A–Z'], ['other','Другие']];
  return `<div class="library-tools"><input id="libq" class="field" aria-label="Поиск" placeholder="Фильм или режиссёр" value="${esc(ui.q)}"><div class="library-letters" role="group" aria-label="Алфавитный указатель">${letters.map(([key,label])=>`<button class="mini ${ui.libraryLetter===key?'on':''}" aria-pressed="${ui.libraryLetter===key}" data-a="${on(()=>{ui.libraryLetter=key;ui.shown=40;render();})}">${label}</button>`).join('')}</div></div><div class="row"><span class="sub">Порядок:</span>${[['name','По имени'],['surname','По фамилии']].map(([key,label])=>`<button class="mini ${mode===key?'on':''}" aria-pressed="${mode===key}" data-a="${on(async()=>{ui.libraryLetter='all';ui.shown=40;await doState('setLibrarySort',key);})}">${label}</button>`).join('')}<button class="mini ${ui.libraryNeeds?'on':''}" aria-pressed="${ui.libraryNeeds}" data-a="${on(()=>{ui.libraryNeeds=!ui.libraryNeeds;ui.shown=40;render();})}">Нужно выбрать следующий фильм</button>${ui.libraryLetter!=='all'||ui.libraryNeeds||ui.q?`<button class="mini" data-a="${on(()=>{ui.libraryLetter='all';ui.libraryNeeds=false;ui.q='';ui.shown=40;render();})}">Сбросить фильтры</button>`:''}</div>`;
}

function library() {
  const s = ui.state;
  const q = ui.q.trim().toLowerCase().replace(/ё/g, 'е');
  const films = Object.values(s.films);
  const by = new Map();
  films.forEach((f) => { if (!by.has(f.dir)) by.set(f.dir, []); by.get(f.dir).push(f); });
  const norm = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е');
  const dirs = Object.values(s.directors).filter((d) => (by.get(d.id) || []).some((f) => ['queue', 'reserve'].includes(f.status)) || d.needsChoice)
    .filter((d) => !q || directorNames(d).some(n=>norm(n).includes(q)) || (by.get(d.id) || []).some((f) => norm(titleOf(f)).includes(q) || norm(f.originalTitle).includes(q)))
    .filter(d => !ui.libraryNeeds || d.needsChoice)
    .filter(d => ui.libraryLetter === 'all' || directorLetter(d) === ui.libraryLetter)
    .sort((a,b) => {
      const group = d => directorLetter(d)==='latin'?1:directorLetter(d)==='other'?2:0;
      return group(a)-group(b) || directorSortKey(a).localeCompare(directorSortKey(b),'ru') || a.name.localeCompare(b.name,'ru') || String(a.id).localeCompare(String(b.id),'en');
    });
  const cards = dirs.slice(0, ui.shown).map((d) => {
    const fs = by.get(d.id) || [];
    const q2 = fs.filter((f) => f.status === 'queue');
    return `<section class="card"><div class="row between"><div><h2>${esc(d.name)}</h2>${d.tmdbName&&d.tmdbName!==d.name?`<div class="sub">TMDB: ${esc(d.tmdbName)}</div>`:''}<div class="sub">Посмотрено: ${fs.filter((f) => f.status === 'watched').length}, в запасе: ${fs.filter((f) => f.status === 'reserve').length}</div></div>${d.fav ? '<span class="tag gold">Любимый</span>' : ''}</div>${nearDirectorSummary(d.id)}${q2.map((f) => filmRow(f)).join('')}${d.needsChoice ? `<button class="btn primary" data-a="${on(() => openDirector(d.id))}">Выбрать следующий фильм</button>` : ''}<div class="row"><button class="mini" data-a="${on(()=>{ui.modal={type:'director-name',id:d.id};render();})}">Имя режиссёра</button><button class="mini" data-a="${on(() => openMarkup(d.id))}">Разметить фильмографию</button><button class="mini ${d.fav ? 'on' : ''}" data-a="${on(() => doState('toggleFav', d.id))}">${d.fav ? 'Любимый режиссёр' : 'Отметить любимым'}</button></div></section>`;
  }).join('');
  return `<div class="head"><div><h1>Библиотека</h1><div class="sub">Режиссёров: ${dirs.length}. Правая кнопка мыши на фильме открывает меню.</div></div><button class="btn primary" data-a="${on(() => { ui.modal = { type: 'add', q: '', results: null }; render(); })}">Добавить фильм или режиссёра</button></div>${libraryControls()}<div class="grid">${cards || '<div class="sub">По этим условиям режиссёры не найдены.</div>'}</div>${dirs.length > ui.shown ? `<button class="btn" data-a="${on(() => { ui.shown += 40; render(); })}">Показать ещё</button>` : ''}`;
}

function near() {
  const s = ui.state;
  const rows = s.near.map((e, i) => {
    const films = e.ids.map((k) => s.films[k]).filter(Boolean);
    return `<div class="film drag" draggable="true" data-entry="${esc(e.key)}" data-idx="${i}"><div style="flex:1;min-width:280px">${films.map((f, j) => `<div class="fwrap" data-film="${f.key}" style="${j ? 'margin-top:8px' : ''}">${posterHtml(f.poster)}<div><div class="ftitle">${j ? '<span class="sub">или </span>' : ''}${filmLine(f)}</div><div class="fmeta">${esc((s.directors[f.dir] || {}).name || '')}${filmMeta(f) ? ` · ${filmMeta(f)}` : ''}</div></div></div>`).join('')}</div><div class="row">${films.map(diskTags).join('')}<button class="mini" aria-label="Выше" data-a="${on(() => doState('moveNear', e.key, i - 1))}">↑</button><button class="mini" aria-label="Ниже" data-a="${on(() => doState('moveNear', e.key, i + 1))}">↓</button><button class="mini" data-menu="${films[0].key}">Ещё</button></div></div>`;
  }).join('');
  return `<div class="head"><div><h1>Ближайшие</h1><div class="sub">Перетаскивай строки мышью или меняй порядок стрелками. Варианты «или» стоят в одной строке: когда посмотришь один, строка уйдёт из списка.</div></div></div><div class="list">${rows || '<div class="card sub">Список пуст. Добавь фильм через правую кнопку в библиотеке.</div>'}</div>`;
}

function rewatch() {
  const list = Object.values(ui.state.films).filter((f) => f.rewatch);
  return `<div class="head"><div><h1>Пересмотреть</h1><div class="sub">Фильмы, к которым хочется вернуться.</div></div></div><div class="list">${list.map((f) => filmRow(f, `<button class="mini" data-a="${on(() => doState('toggleRewatch', f.key))}">Убрать</button>`)).join('') || '<div class="card sub">Пока пусто. Добавить можно через правую кнопку или в утреннем разборе.</div>'}</div>`;
}

function morning() {
  const planned = new Set((ui.state.nights || []).filter(n=>n.slots.some(s=>!s.result)).flatMap(n => n.slots.map(s => s.key)));
  const list = Object.values(ui.state.films).filter((f) => f.pending || f.moveTask);
  const todayFilms = allEntries().filter((e) => !planned.has(e.filmKey) && e.role === 'today' && e.state === 'linked' && e.filmKey && ['queue', 'reserve', 'candidate'].includes((ui.state.films[e.filmKey] || {}).status)).map((e) => ui.state.films[e.filmKey]);
  const status = async (f, st) => { const r = await doState('setFilmStatus', f.key, st); if (r.askDirector != null) openDirector(r.askDirector); };
  const today = todayFilms.length ? `<section class="card"><h2>Лежит в папке «Сегодня», вне утверждённых ночей: что посмотрел?</h2>${[...new Set(todayFilms)].map((f) => `<div class="film"><div class="fwrap">${posterHtml(f.poster)}<div class="ftitle">${filmLine(f)}</div></div><div class="row"><button class="mini on" data-a="${on(() => status(f, 'watched'))}">Посмотрел</button><button class="mini" data-a="${on(() => status(f, 'dropped'))}">Бросил</button></div></div>`).join('')}</section>` : '';
  const cards = list.map((f) => {
    const paths = ui.files.get(f.key) || [];
    return `<section class="card"><div class="fwrap">${posterHtml(f.poster, true)}<div><h2>${filmLine(f)}</h2><div class="sub">${f.status === 'dropped' ? 'Брошен' : 'Посмотрен'} · ${esc((ui.state.directors[f.dir] || {}).name || '')}</div></div></div>${f.pending ? `<div class="row" style="gap:4px" aria-label="Оценка">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button class="mini ${f.rating === n ? 'on' : ''}" data-a="${on(() => doState('rate', f.key, n))}">${n}</button>`).join('')}</div><div class="row"><button class="mini ${f.rewatch ? 'on' : ''}" data-a="${on(() => doState('toggleRewatch', f.key))}">В «Пересмотреть»</button><button class="btn ${f.moveTask ? '' : 'primary'}" data-a="${on(() => doState('finishReview', f.key))}">Оценка готова</button></div>` : ''}${f.moveTask ? `<div class="label">Перенеси на резервный диск и удали отсюда${paths.length > 1 ? `. Копий: ${paths.length}` : ''}</div>${paths.map((e) => `<div class="film"><div class="path">${esc(e.path)}<br>${gb(e.size)}</div><button class="mini" data-a="${on(() => call('openEntry', e.id))}">Открыть папку</button></div>`).join('')}<div class="row"><button class="mini" data-a="${on(() => doState('keepOnDisk', f.key))}">Оставить на диске</button><button class="mini" data-a="${on(() => runScan())}">Я перенёс, проверить</button></div>` : ''}</section>`;
  }).join('');
  return `<div class="head"><div><h1>Утренний разбор</h1><div class="sub">Задача на перенос закроется сама, когда файла не останется ни в одной папке.</div></div></div>${typeof nightMorning === 'function' ? nightMorning() : ''}${today}<div class="grid wide">${cards || (today ? '' : '<div class="card sub">Задач нет.</div>')}</div>`;
}

function downloadList() {
  const nearIds = new Set(ui.state.near.flatMap((e) => e.ids));
  return Object.values(ui.state.films).filter((f) => ['queue', 'reserve'].includes(f.status) && !(ui.files.get(f.key) || []).length).sort((a, b) => Number(nearIds.has(b.key)) - Number(nearIds.has(a.key)) || Number(a.status === 'reserve') - Number(b.status === 'reserve') || titleOf(a).localeCompare(titleOf(b), 'ru'));
}
function download() {
  const nearIds = new Set(ui.state.near.flatMap((e) => e.ids));
  const list = downloadList();
  const note = (ui.state.folders || []).length ? (ui.state.allConnected ? 'Как только файл появится на диске и пройдёт сканирование, фильм исчезнет из списка.' : 'Подключены не все диски: часть этих фильмов может лежать на других. Отметь «Подключены все диски» в разделе «Диски», когда добавишь их.') : 'Диски ещё не подключены, поэтому здесь пока весь список.';
  return `<div class="head"><div><h1>Скачать</h1><div class="sub">Фильмов: ${list.length}. ${note}</div></div></div><div class="list">${list.slice(0, ui.shown).map((f) => `<div class="film" data-film="${f.key}"><div class="fwrap">${posterHtml(f.poster)}<div><div class="ftitle">${filmLine(f)}</div><div class="fmeta">${esc((ui.state.directors[f.dir] || {}).name || '')} · ${nearIds.has(f.key) ? 'в ближайших' : 'в очереди режиссёра'}</div></div></div><div class="row"><button class="mini" data-a="${on(() => call('openExternal', f.kpLink || kpSearch(f)))}">Кинопоиск</button><button class="mini" data-a="${on(() => doState('setFilmStatus', f.key, 'notfound'))}">Не нашёл</button></div></div>`).join('')}</div>${list.length > ui.shown ? `<button class="btn" data-a="${on(() => { ui.shown += 40; render(); })}">Показать ещё</button>` : ''}`;
}
const kpSearch = (f) => `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(`${f.originalTitle || titleOf(f)} ${f.year || ''}`)}`;

async function runScan(only) {
  if (ui.scan) return false;
  ui.scan = { running: true, current: 'Начинаю сканирование', found: 0 }; render();
  try {
    await bridge.call('scanAll', only);
    ui.state = await bridge.call('getState');
    await loadDiskExtras();
    const s = ui.state.scan;
    if (s && s.offline && s.offline.length) say(`Недоступна папка: ${s.offline[0]}`);
    return true;
  } catch (e) {
    say(String(e.message || e));
    return false;
  } finally {
    ui.scan = null;
    render();
  }
}
async function verifyDuplicates() {
  if (!await runScan()) return;
  const scan = ui.state.scan || {};
  if ((scan.offline || []).length || (scan.errors || []).length || Object.keys(ui.state.lost || {}).length) {
    say('Проверка неполная: часть папок недоступна или требует проверки. Посмотри раздел «Папки».');
  } else {
    say(ui.dups.length ? `Проверено. Фильмов с дублями осталось: ${ui.dups.length}.` : 'Проверено: дублей не осталось.');
  }
}
function renameSignature(p) {
  return JSON.stringify([p.id,p.dir,p.from,p.to,p.filmKey,p.title,p.fileYear,p.filmYear,p.matchMethod,p.requiresConfirmation,p.duration]);
}
async function loadDiskExtras() {
  ui.dups = await bridge.call('duplicates');
  const previous = new Map((ui.plan || []).map(p => [p.id, renameSignature(p)]));
  const next = await bridge.call('renamePlan');
  const unchanged = new Set(next.filter(p => previous.get(p.id) === renameSignature(p)).map(p => p.id));
  ui.planOn = new Set([...(ui.planOn || [])].filter(id => unchanged.has(id)));
  ui.planOff = new Set([...(ui.planOff || [])].filter(id => unchanged.has(id)));
  ui.plan = next;
  if (ui.screen === 'disks') render();
  if (ui.screen === 'disks' && ui.diskTab === 'orphans') loadOrphans();
}
async function pickAndAdd(role) {
  const p = await call('pickFolder');
  if (!p) return;
  await doState('addFolder', p, role);
  if (role !== 'exclude') runScan(p);
}
function orphanNeedsLoad(e) {
  if (ui.orphanErrors && ui.orphanErrors[e.id]) return false;
  const found = ui.orphanSearch[e.id];
  return !found || found.some((c) => !ui.candInfo[c.id]);
}
function nextOrphanToLoad() {
  if (ui.screen !== 'disks' || ui.diskTab !== 'orphans') return null;
  return allEntries().filter((e) => e.state === 'orphan').slice(0, ui.orphanShown)
    .find((e) => !e.candidates && orphanNeedsLoad(e));
}
async function loadOrphans() {
  if (ui.orphanLoading || !nextOrphanToLoad()) return;
  ui.orphanLoading = true;
  ui.orphanErrors = ui.orphanErrors || {};
  try {
    let e;
    // Re-read visible cards: resolving a film reveals new rows while requests are running.
    while ((e = nextOrphanToLoad())) {
      try {
        if (!ui.orphanSearch[e.id]) {
          const q = ui.orphanQ[e.id] || `${e.title}${e.year ? ` (${e.year})` : ''}`;
          const r = await bridge.call('searchForReview', q);
          ui.orphanSearch[e.id] = r.cands;
        }
        const ids = ui.orphanSearch[e.id].map((c) => c.id).filter((id) => !ui.candInfo[id]);
        if (ids.length) {
          const info = await bridge.call('candidateInfo', ids);
          Object.assign(ui.candInfo, info);
          if (ids.some((id) => !ui.candInfo[id])) throw new Error('Не удалось загрузить сведения о некоторых вариантах.');
        }
      } catch (err) {
        ui.orphanErrors[e.id] = 'Не удалось загрузить варианты или сведения TMDB. Можно повторить загрузку.';
      }
      if (ui.screen === 'disks') render();
    }
  } finally {
    ui.orphanLoading = false;
    if (ui.screen === 'disks') render();
  }
}
async function searchOrphan(e) {
  delete ui.orphanSearch[e.id];
  ui.orphanErrors = ui.orphanErrors || {};
  delete ui.orphanErrors[e.id];
  try {
    const r = await bridge.call('searchForReview', ui.orphanQ[e.id] || e.title);
    ui.orphanSearch[e.id] = r.cands;
    const ids = r.cands.map((c) => c.id).filter((id) => !ui.candInfo[id]);
    if (ids.length) {
      Object.assign(ui.candInfo, await bridge.call('candidateInfo', ids));
      if (ids.some((id) => !ui.candInfo[id])) throw new Error('Incomplete candidate details');
    }
  } catch (err) {
    ui.orphanErrors[e.id] = 'Не удалось загрузить варианты или сведения TMDB. Можно повторить загрузку.';
  }
  render();
}

function retryOrphan(id) {
  const e = allEntries().find((x) => x.id === id);
  if (e && e.candidates) return searchOrphan(e);
  if (ui.orphanErrors) delete ui.orphanErrors[id];
  render();
  return loadOrphans();
}

function directorQueue(tmdbId) {
  const f = ui.state.films[`m${tmdbId}`];
  const info = ui.candInfo[tmdbId];
  const dir = f ? f.dir : info && info.directorIds && info.directorIds[0];
  if (dir == null) return null;
  const films = Object.values(ui.state.films).filter((x) => x.dir === dir && x.status === 'queue');
  return { dir, films, name: (ui.state.directors[dir] || {}).name || (info && info.directors[0]) || 'Режиссёр' };
}
function queueContext(tmdbId) {
  const q = directorQueue(tmdbId);
  if (!q) return '<div class="sub">Очередь режиссёра пока не определена.</div>';
  return `<div class="sub" style="margin-top:8px">${esc(q.name)} · в очереди: ${q.films.length}${q.films.length ? `<br>${q.films.map((f) => esc(titleOf(f))).join(' · ')}` : '<br>Пока нет выбранных фильмов.'}</div>${q.films.length >= 3 ? '<div class="sub warn">В очереди уже 3 фильма или больше. Можно добавить ещё один или заменить выбранный.</div>' : ''}`;
}
async function requestQueueAdd(tmdbId, entryId = null) {
  if (!directorQueue(tmdbId)) Object.assign(ui.candInfo, await call('candidateInfo', [tmdbId]));
  const q = directorQueue(tmdbId);
  if (!q) { say('Не удалось определить режиссёра. Попробуй загрузить сведения ещё раз.'); return; }
  const f = ui.state.films[`m${tmdbId}`];
  if (q.films.length >= 3 && (!f || f.status !== 'queue')) {
    ui.modal = { type: 'queue', tmdbId, entryId };
    render();
    return;
  }
  await applyQueueAdd(tmdbId, entryId);
}
async function applyQueueAdd(tmdbId, entryId, options = {}) {
  if (entryId != null) await doState('addEntryFilm', entryId, tmdbId, 'queue', options);
  else await doState('addFilm', tmdbId, options);
  ui.modal = null;
  render();
}

function knownFilmTag(f) {
  if (!f) return '';
  const labels = { queue: 'Уже в очереди', reserve: 'В запасе', disk: 'Только учтён на диске', watched: 'Уже просмотрен', dropped: 'Брошен', notfound: 'Отмечен как «Не нашёл»', nointerest: 'Не интересует', candidate: 'Уже есть в фильмографии' };
  return `<span class="tag gold">${esc(labels[f.status] || 'Уже в библиотеке')}</span>`;
}

function orphanCard(e) {
  const mine = (e.candidates || []).map((k) => ui.state.films[k]).filter(Boolean);
  const found = ui.orphanSearch[e.id] || [];
  const candRow = (c) => {
    const i = ui.candInfo[c.id];
    const known = ui.state.films[`m${c.id}`];
    const canQueue = !known || ['disk', 'reserve', 'candidate'].includes(known.status);
    return `<div class="film choice"><div class="fwrap">${posterHtml(i && i.poster)}<div style="min-width:0"><div class="ftitle">${esc(c.title)}${c.year ? ` (${c.year})` : ''}</div>${knownFilmTag(known)}<div class="fmeta">${esc(c.originalTitle || '')}</div><div class="fmeta">${esc(i ? [i.directors.join(', '), i.runtime ? `${i.runtime} мин` : null].filter(Boolean).join(' · ') : '')}</div>${queueContext(c.id)}</div></div><div class="col2">${known ? `<button class="mini on" data-a="${on(() => doState('chooseEntryFilm', e.id, known.key))}">Это он — связать файл</button>` : ''}${canQueue ? `<button class="mini on" data-a="${on(() => requestQueueAdd(c.id, e.id))}">Добавить в очередь</button>` : ''}${!known ? `<button class="mini" title="Запомнить фильм и его файлы без добавления в очередь просмотра" data-a="${on(() => doState('addEntryFilm', e.id, c.id, 'disk'))}">Только учитывать на диске</button>` : ''}${!known || !['watched', 'dropped'].includes(known.status) ? `<button class="mini" data-a="${on(() => doState('addEntryFilm', e.id, c.id, true))}">Уже смотрел</button>` : ''}</div></div>`;
  };
  return `<section class="card"><div><h2>${esc(e.title)}${e.year ? ` (${e.year})` : ''}</h2><div class="path">${esc(e.path)}</div><div class="sub">${kindName[e.kind] || ''} · ${gb(e.size)}${e.duration ? ` · ${e.duration} мин` : ''}</div></div>${mine.length ? `<div class="sub warn">Совпало с несколькими фильмами списка:</div>${mine.map((f) => `<div class="film"><div class="fwrap">${posterHtml(f.poster)}<div class="ftitle">${filmLine(f)}${knownFilmTag(f)}<div class="fmeta">${esc((ui.state.directors[f.dir] || {}).name || '')}${f.runtime ? ` · ${f.runtime} мин` : ''}</div></div></div><button class="mini on" data-a="${on(() => doState('chooseEntryFilm', e.id, f.key))}">Это он</button></div>`).join('')}` : ''}<div class="list">${found.map(candRow).join('') || (mine.length ? '' : `<div class="sub">${ui.orphanErrors && ui.orphanErrors[e.id] ? 'Загрузка не завершена.' : ui.orphanSearch[e.id] ? 'Вариантов не найдено. Попробуй другое название или ссылку TMDB.' : 'Ищу варианты…'}</div>`)}</div>${ui.orphanErrors && ui.orphanErrors[e.id] ? `<div class="sub warn">${esc(ui.orphanErrors[e.id])}</div><button class="mini" data-a="${on(() => retryOrphan(e.id))}">Повторить загрузку</button>` : ''}<div class="row"><input class="field" id="orp${esc(e.id)}" data-orpq="${esc(e.id)}" aria-label="Поиск в TMDB" placeholder="Название, режиссёр или ссылка TMDB" value="${esc(ui.orphanQ[e.id] || '')}"><button class="btn" data-a="${on(async () => { await searchOrphan(e); })}">Найти</button><button class="btn ghost" data-a="${on(() => call('openEntry', e.id))}">Открыть папку</button><button class="btn ghost" data-a="${on(() => ignoreFile(e.id))}">Игнорировать</button></div></section>`;
}
async function restoreIgnored(id) {
  await doState('unignoreEntry', id);
  await loadDiskExtras();
  render();
}
async function ignoreFile(id) {
  await doState('ignoreEntry', id);
  say('Фильм скрыт. Он доступен во вкладке «Игнорируемые».', { label: 'Отменить', run: () => restoreIgnored(id) });
}
function renameSelected(p) {
  return p.requiresConfirmation ? !!(ui.planOn && ui.planOn.has(p.id)) : !(ui.planOff && ui.planOff.has(p.id));
}
function renameCard(p) {
  const f = ui.state.films[p.filmKey] || {};
  const reasons = { manual: 'Ты подтвердил фильм вручную', memory: 'Сохранённая связь по названию и году', name: 'Только по совпадению названия в библиотеке', 'name-year': 'По совпадению названия и года', 'name-near-year': 'По названию и году с расхождением в один год', duration: 'По названию и близкой длительности', moved: 'По прежней связи при перемещении', unknown: 'Связь из прежней версии: способ сопоставления не сохранён' };
  const selected = renameSelected(p);
  return `<section class="card"><div class="fmeta">${esc(p.from)} → <strong>${esc(p.to)}</strong></div><div class="path">${esc(p.dir)}</div><div class="fwrap" style="margin-top:10px">${posterHtml(f.poster)}<div><div class="ftitle">${filmLine(p.title ? { ...f, userTitle: p.title } : f)}</div><div class="sub">${esc((ui.state.directors[f.dir] || {}).name || 'Режиссёр не указан')}</div><div class="sub">Длительность файла: ${p.duration ? `${p.duration} мин` : 'неизвестна'} · TMDB: ${f.runtime ? `${f.runtime} мин` : 'неизвестна'}</div><div class="sub">${esc(reasons[p.matchMethod] || reasons.unknown)}</div>${p.requiresConfirmation ? '<div class="sub warn">Проверь фильм и год. Без подтверждения строка не переименовывается.</div>' : ''}</div></div><div class="row"><button class="mini ${selected ? 'on' : ''}" data-a="${on(() => {
    if (p.requiresConfirmation) { ui.planOn = ui.planOn || new Set(); if (selected) ui.planOn.delete(p.id); else ui.planOn.add(p.id); }
    else { ui.planOff = ui.planOff || new Set(); if (selected) ui.planOff.add(p.id); else ui.planOff.delete(p.id); }
    render();
  })}">${selected ? 'Выбрано — не менять' : p.requiresConfirmation ? 'Фильм и год верны — выбрать' : 'Выбрать'}</button><button class="mini" data-a="${on(() => call('openEntry', p.id))}">Открыть папку</button><button class="mini" data-a="${on(async () => {
    await doState('unlinkEntry', p.id); ui.diskTab = 'orphans';
    delete ui.orphanSearch[p.id]; await loadDiskExtras(); render();
  })}" >Это другой фильм</button><button class="mini" data-a="${on(async()=>{await doState('setRenamePreference',p.id,'keep');await loadDiskExtras();render();})}">Оставить как есть</button><button class="mini" data-a="${on(()=>{ui.modal={type:'file-name',id:p.id,name:p.to};render();})}">Ввести имя вручную</button></div></section>`;
}

function disks() {
  const s = ui.state;
  const es = allEntries();
  const orphans = es.filter((e) => e.state === 'orphan');
  const series = es.filter((e) => e.state === 'series');
  const tabs = [['folders', 'Папки', 0], ['orphans', 'Нужно разобрать', orphans.length], ['stored', 'Учтены на диске', Object.values(s.films).filter((f) => f.status === 'disk').length], ['dups', 'Дубли', ui.dups.length], ['series', 'Похоже на сериал', series.length], ['ignored', 'Игнорируемые', es.filter((e) => e.state === 'ignored').length], ['rename', 'Названия', ui.plan.length]];
  const tabHtml = `<div class="row">${tabs.map((t) => `<button class="chip ${ui.diskTab === t[0] ? 'on' : ''}" data-a="${on(() => { ui.diskTab = t[0]; render(); if (t[0] === 'orphans') loadOrphans(); })}">${t[1]}${t[2] ? ` · ${t[2]}` : ''}</button>`).join('')}</div>`;
  const lost = Object.values(s.lost || {}).map((l) => `<div class="error"><h3>Потеряно фильмов: ${l.count}. Обнови путь</h3><div class="sub" style="color:#f4d9c8">Папка ${esc(l.path)}: ${esc(l.reason)}. Пока ты не ответишь, задачи не закрываются, а эти фильмы не считаются пропавшими.</div><div class="row" style="margin-top:8px"><button class="btn primary" data-a="${on(async () => { const p = await call('pickFolder'); if (p) { ui.scan = { running: true, current: 'Сканирую новый путь', found: 0 }; render(); await call('updateFolderPath', l.path, p); await refresh(); ui.scan = null; await loadDiskExtras(); render(); } })}">Обновить путь</button><button class="btn" data-a="${on(() => runScan(l.path))}">Проверить снова</button><button class="btn ghost" data-a="${on(async () => { await call('confirmLost', l.path); await refresh(); await loadDiskExtras(); })}">Да, я их убрал</button></div></div>`).join('');
  const roleNames = { normal: 'Обычная', today: '«Сегодня»', exclude: 'Исключить' };
  const stat = { ok: 'Сканирована', offline: 'Недоступна', suspicious: 'Нужна проверка' };
  let body = '';
  if (ui.diskTab === 'folders') {
    body = `<section class="card"><div class="row between"><h2>Папки с фильмами</h2><div class="row"><button class="btn primary" data-a="${on(() => pickAndAdd('normal'))}">Добавить папку</button><button class="btn" data-a="${on(() => pickAndAdd('exclude'))}">Исключить папку</button><button class="btn" ${ui.scan ? 'disabled' : ''} data-a="${on(() => runScan())}">Сканировать всё</button></div></div>${(s.folders || []).map((f) => `<div class="film"><div><div class="ftitle">${esc(f.path)}</div><div class="fmeta">${f.role === 'exclude' ? 'Программа сюда не заходит' : `${stat[f.status] || 'Ещё не сканирована'}${f.count != null ? ` · найдено: ${f.count}` : ''}`}</div></div><div class="row" style="gap:4px">${Object.keys(roleNames).map((r) => `<button class="mini ${f.role === r ? 'on' : ''}" data-a="${on(() => doState('setFolderRole', f.path, r))}">${roleNames[r]}</button>`).join('')}<button class="mini" ${ui.scan ? 'disabled' : ''} data-a="${on(() => runScan(f.path))}">Сканировать</button><button class="mini" data-a="${on(() => doState('removeFolder', f.path))}">Убрать</button></div></div>`).join('') || '<div class="sub">Подключай по одной папке, например U:\\Фильмы. Программа только читает их и ничего не меняет без твоего подтверждения.</div>'}<label class="row" style="margin-top:6px"><input type="checkbox" id="allconn" ${s.allConnected ? 'checked' : ''}><span class="sub">Подключены все диски: можно точно считать, что остальное нужно скачать</span></label></section>`;
  }
  if (ui.diskTab === 'orphans') {
    body = `<div class="sub">Эти файлы пока не связаны с фильмами библиотеки. Выбери правильный фильм и действие: добавить в очередь или только учитывать на диске. Если фильм уже есть в библиотеке, кнопка «Это он» сохранит его очередь и отметки.</div><div class="grid wide">${orphans.slice(0, ui.orphanShown).map(orphanCard).join('') || '<div class="card sub">Всё сопоставлено.</div>'}</div>${orphans.length > ui.orphanShown ? `<button class="btn" data-a="${on(() => { ui.orphanShown += 12; render(); loadOrphans(); })}">Показать ещё</button>` : ''}`;
  }
  if (ui.diskTab === 'stored') {
    const stored = Object.values(s.films).filter((f) => f.status === 'disk');
    body = `<div class="sub">Фильмы учтены для поиска файлов и дублей, но не добавлены в очередь просмотра. Добавить их можно в любой момент.</div><div class="list">${stored.map((f) => `<section class="card">${filmRow(f, `<button class="mini on" data-a="${on(() => requestQueueAdd(f.tmdbId))}">Добавить в очередь</button>`)}${queueContext(f.tmdbId)}</section>`).join('') || '<div class="card sub">Пока пусто.</div>'}</div>`;
  }
  if (ui.diskTab === 'dups') {
    body = `<section class="card"><div class="row between"><div><h2>Проверка дублей</h2><div class="sub">Убрал лишние копии вручную? Проверь папки повторно — список обновится без перезапуска.</div></div><button class="btn primary" ${ui.scan ? 'disabled' : ''} data-a="${on(verifyDuplicates)}">${ui.scan ? 'Проверяю…' : 'Я разобрал — проверить'}</button></div></section><div class="grid wide">${ui.dups.map((d) => { const f = s.films[d.key]; return `<section class="card"><div class="row between"><h2>${filmLine(f)}</h2><span class="tag ${d.identical ? 'bad' : 'gold'}">${d.identical ? 'Вероятно, точная копия' : 'Разный размер'}</span></div>${d.copies.map((c) => `<div class="film"><div><div class="ftitle">${gb(c.size)} · ${kindName[c.kind] || ''}${c.role === 'today' ? ' · в «Сегодня»' : ''}</div><div class="path">${esc(c.path)}</div></div><button class="mini" data-a="${on(() => call('openEntry', c.id))}">Открыть папку</button></div>`).join('')}<div class="row"><button class="mini" data-a="${on(async () => { await doState('duplicateOk', d.key); await loadDiskExtras(); })}">Это разные версии, не напоминать</button></div></section>`; }).join('') || '<div class="card sub">Дублей не найдено.</div>'}</div>`;
  }
  if (ui.diskTab === 'series') {
    body = `<div class="list">${series.map((e) => `<div class="film"><div><div class="ftitle">${esc(e.name)}</div><div class="path">${esc(e.path)}</div><div class="fmeta">${gb(e.size)}</div></div><div class="row"><button class="mini" data-a="${on(() => doState('entryIsFilm', e.id))}">Это фильм</button>${e.kind === 'series' ? `<button class="mini" data-a="${on(() => doState('excludeSeriesFolder', e.path))}">Исключить папку</button>` : ''}</div></div>`).join('') || '<div class="card sub">Сериалов не найдено.</div>'}</div>`;
  }
  if (ui.diskTab === 'ignored') {
    const ignored = es.filter((e) => e.state === 'ignored');
    body = `<div class="sub">Эти файлы скрыты из разбора. Их можно вернуть без повторного добавления папки.</div><div class="list">${ignored.map((e) => `<div class="film"><div><div class="ftitle">${esc(e.title || e.name)}</div><div class="path">${esc(e.path)}</div></div><button class="mini" data-a="${on(() => restoreIgnored(e.id))}">Вернуть в разбор</button></div>`).join('') || '<div class="card sub">Игнорируемых файлов нет.</div>'}</div>`;
  }
  if (ui.diskTab === 'rename') {
    const selected = ui.plan.slice(0, 300).filter(renameSelected);
    body = `<section class="card"><h2>Единый стиль названий</h2><div class="sub">Проверь, какой фильм связан с файлом. Год берётся из этой записи TMDB. Сомнительные строки требуют отдельного подтверждения. Меняется только имя внешней папки или файла.</div><button class="btn primary" ${selected.length ? '' : 'disabled'} data-a="${on(async () => {
      const rows = ui.plan.slice(0, 300).filter(renameSelected);
      const r = await call('applyRename', rows.map((p) => p.id), rows.filter((p) => p.requiresConfirmation).map((p) => p.id));
      ui.state = r.state; ui.planFailed = r.failed; await loadDiskExtras(); render();
    })}">Переименовать выбранные (${selected.length})</button></section>${ui.planFailed.map((x) => `<div class="error">${esc(x.from)}: ${esc(x.why)}</div>`).join('')}<div class="list">${ui.plan.slice(0, 300).map(renameCard).join('') || '<div class="card sub">Предложений по переименованию нет.</div>'}</div>${ui.plan.length > 300 ? '<div class="sub">Показаны первые 300 строк. Остальные доступны после их разбора.</div>' : ''}${(s.renameLog || []).length ? `<section class="card"><h2>Журнал переименований</h2>${s.renameLog.map((l, i) => ({ l, i })).reverse().slice(0, 50).map(({ l, i }) => `<div class="film"><div class="path">${esc(l.from)} → ${esc(l.to)}</div><button class="mini" data-a="${on(async () => { await call('undoRename', i); await refresh(); await loadDiskExtras(); })}">Отменить</button></div>`).join('')}</section>` : ''}`;
  }
  if (ui.diskTab === 'rename') {
    const kept = es.filter(e=>e.renamePreference==='keep');
    if(kept.length) body += `<section class="card"><h2>Оставлены без переименования</h2>${kept.map(e=>`<div class="film"><div class="path">${esc(e.path)}</div><button class="mini" data-a="${on(async()=>{await doState('setRenamePreference',e.id,'auto');await loadDiskExtras();render();})}">Снова предлагать имя</button></div>`).join('')}</section>`;
  }
  const scanNote = ui.scan ? `<div class="notice">${esc(ui.scan.current || '')}${ui.scan.found ? ` · найдено: ${ui.scan.found}` : ''}</div>` : '';
  return `<div class="head"><div><h1>Диски</h1><div class="sub">Программа только читает папки. Удалять и перемещать фильмы ты будешь сам.</div></div></div>${lost}${scanNote}${tabHtml}${body}`;
}

const PAGE = 12;
function candHtml(r, c) {
  const i = ui.candInfo[c.id];
  const meta = i ? [i.directors.join(', ') || 'режиссёр не указан', i.runtime ? `${i.runtime} мин` : null, (i.countries || [])[0] ? countryRu(i.countries[0]) : null].filter(Boolean).join(' · ') : 'Загружаю сведения…';
  return `<div class="film choice"><div class="fwrap">${posterHtml(i && i.poster, true)}<div style="min-width:0"><div class="ftitle">${esc(c.title)}${c.year ? ` (${c.year})` : ''}</div><div class="fmeta">${esc(c.originalTitle || '')}</div><div class="fmeta">${esc(meta)}</div>${i && i.overview ? `<div class="overview">${esc(i.overview)}</div>` : ''}</div></div><button class="mini on" data-a="${on(async () => { ui.review = await call('resolveItem', r.id, c.id); await refresh(); loadCandInfo(); })}">Это он</button></div>`;
}
function review() {
  const list = ui.review.slice(0, ui.reviewShown);
  const rows = list.map((r) => {
    const results = ui.reviewResults[r.id] || r.cands;
    return `<section class="card"><div><h2>${esc(r.title)}${r.year ? ` (${r.year})` : ''}</h2><div class="sub warn">${esc(r.why)}</div>${r.mates.length ? `<div class="sub">В этой же строке: ${esc(r.mates.join(', '))}</div>` : ''}${r.source ? `<div class="sub">Из списка: ${esc(r.source)}</div>` : ''}</div><div class="list">${results.map((c) => candHtml(r, c)).join('') || '<div class="sub">Вариантов нет. Попробуй поискать иначе.</div>'}</div>${(ui.reviewPeople[r.id] || []).map((p) => `<button class="btn ghost" data-a="${on(async () => { ui.reviewResults[r.id] = await call('directorFilms', p.id); ui.reviewNote[r.id] = `Фильмы режиссёра: ${p.name}`; ui.reviewPeople[r.id] = []; render(); loadCandInfo(); })}">Показать фильмы режиссёра: ${esc(p.name)}</button>`).join('')}${ui.reviewNote[r.id] ? `<div class="sub">${esc(ui.reviewNote[r.id])}</div>` : ''}<div class="row"><input class="field" id="revq${r.id}" data-revq="${r.id}" aria-label="Поиск в TMDB" placeholder="Название, режиссёр или ссылка TMDB" value="${esc(ui.reviewQ[r.id] || '')}"><button class="btn" data-a="${on(() => searchReview(r.id, r.title))}">Найти</button>${r.link ? `<button class="btn ghost" data-a="${on(() => call('openExternal', r.link))}">Кинопоиск</button>` : ''}<button class="btn ghost" data-a="${on(async () => { ui.review = await call('skipItem', r.id); await refresh(); })}">Пропустить</button></div></section>`;
  }).join('');
  const banner = ui.rescue === 'running' ? '<div class="notice">Ищу спорные фильмы в фильмографиях режиссёров из той же строки таблицы…</div>' : (ui.rescue ? `<div class="notice">Автоматически разобрано: ${ui.rescue.resolved}. Осталось: ${ui.rescue.left}.</div>` : '');
  return `<div class="head"><div><h1>Спорные строки</h1><div class="sub">Осталось: ${ui.review.length}. Подтверди нужный фильм, остальное программа уже приняла сама.</div></div></div>${banner}<div class="grid wide">${rows || '<div class="card sub">Спорных строк нет.</div>'}</div>${ui.review.length > ui.reviewShown ? `<button class="btn" data-a="${on(() => { ui.reviewShown += PAGE; render(); loadCandInfo(); })}">Показать ещё</button>` : ''}`;
}
async function searchReview(id, fallback) {
  const q = ui.reviewQ[id] || fallback;
  const res = await call('searchForReview', q);
  ui.reviewResults[id] = res.cands;
  ui.reviewPeople[id] = res.people;
  ui.reviewNote[id] = res.cands.length || res.people.length ? `Результаты поиска: ${q}` : `По запросу «${q}» ничего не нашлось`;
  render();
  loadCandInfo();
}
async function loadCandInfo() {
  if (ui.candLoading) return;
  ui.candLoading = true;
  try {
    for (const r of ui.review.slice(0, ui.reviewShown)) {
      const ids = (ui.reviewResults[r.id] || r.cands).map((c) => c.id).filter((id) => !ui.candInfo[id]);
      if (!ids.length) continue;
      Object.assign(ui.candInfo, await bridge.call('candidateInfo', ids));
      if (ui.screen === 'review') render();
    }
  } catch (e) {
    say('TMDB не ответил: сведения о фильмах загрузятся позже.');
  }
  ui.candLoading = false;
}
async function runRescue() {
  ui.rescue = 'running'; render();
  try {
    ui.rescue = await bridge.call('rescueReview');
    ui.review = await bridge.call('reviewList');
    ui.state = await bridge.call('getState');
  } catch (e) {
    ui.rescue = null;
  }
  render();
  loadCandInfo();
}

async function openDirector(id) {
  const d = ui.state.directors[id];
  return d.marked ? openNext(id) : openMarkup(id);
}
async function openMarkup(id) {
  ui.modal = { type: 'loading', title: 'Загружаю фильмографию' }; render();
  try { ui.modal = { type: 'markup', dir: id, films: await call('filmography', id) }; await refresh(); } catch (e) { ui.modal = null; render(); }
}
async function openNext(id) {
  ui.modal = { type: 'loading', title: 'Загружаю фильмографию' }; render();
  try { await call('filmography', id); await refresh(); ui.modal = { type: 'next', dir: id, chosen: [], sort: 'pop' }; render(); } catch (e) { ui.modal = null; render(); }
}

function markupRating(f) {
  if (!['watched', 'dropped'].includes(f.status)) return '';
  return `<label class="row" style="gap:6px"><span class="sub">Твоя оценка</span><select class="field" style="width:auto" id="rating-${f.key}" data-rating="${f.key}" aria-label="Оценка фильма ${esc(titleOf(f))}"><option value="" ${f.rating == null ? 'selected' : ''}>Без оценки</option>${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `<option value="${n}" ${f.rating === n ? 'selected' : ''}>${n} / 10</option>`).join('')}</select></label>`;
}

function modal() {
  const m = ui.modal;
  if (!m) return '';
  const close = `<button class="mini" data-a="${on(() => { ui.modal = null; render(); })}">Закрыть</button>`;
  let body = '';
  let title = '';
  if (m.type === 'director-name') {
    const d = ui.state.directors[m.id];
    title = 'Имя режиссёра';
    body = `<div class="sub">Задай привычное имя. ID, фильмы, оценки и разметка сохранятся. Поиск работает по твоему имени и сохранённым вариантам TMDB.</div><div class="sub">TMDB: ${esc(d.tmdbName || d.name)}</div><label for="director-name" class="sub">Отображаемое имя</label><input id="director-name" class="field wide" maxlength="150" value="${esc(d.userName || d.name)}"><label for="director-surname" class="sub">Фамилия для сортировки (необязательно)</label><input id="director-surname" class="field wide" maxlength="150" value="${esc(d.sortSurname || '')}" placeholder="Например: Куросава"><div class="sub">Если не указана, используем последнее слово имени. Для составных фамилий и другого порядка слов укажи её вручную.</div><div class="row"><button class="btn primary" data-a="${on(async()=>{await doState('setDirectorName',m.id,document.getElementById('director-name').value,document.getElementById('director-surname').value);ui.modal=null;render();})}">Сохранить имя</button><button class="btn" data-a="${on(async()=>{await doState('setDirectorName',m.id,'');ui.modal=null;render();})}">Вернуть имя TMDB</button><button class="btn" data-a="${on(async()=>{const typed=document.getElementById('director-name').value;const surname=document.getElementById('director-surname').value;await doState('refreshDirectorNames',m.id);const input=document.getElementById('director-name');if(input)input.value=typed;const sortInput=document.getElementById('director-surname');if(sortInput)sortInput.value=surname;})}">Загрузить варианты TMDB</button></div><div class="sub">Известные варианты: ${esc(directorNames(d).filter((v,i,a)=>a.indexOf(v)===i).join(' · '))}</div>`;
  }
  if (m.type === 'file-name') {
    title = 'Имя конкретного файла или папки';
    const e = ui.state.files[m.id];
    const ext = e.kind === 'file' ? String(e.path).match(/\.[^./\\]+$/)?.[0] || '' : '';
    const bodyName = ext && m.name.toLowerCase().endsWith(ext.toLowerCase()) ? m.name.slice(0,-ext.length) : m.name;
    body = `<div class="sub">Расширение ${esc(ext||'(папка)')} сохраняется отдельно. Название в библиотеке и имена других копий не меняются. Год введи в самом имени, если он нужен.</div><input id="custom-file-name" class="field wide" value="${esc(bodyName)}"><button class="btn primary" data-a="${on(async()=>{await doState('setRenamePreference',m.id,'custom',document.getElementById('custom-file-name').value);ui.modal=null;await loadDiskExtras();render();})}">Сохранить предложение</button>`;
  }
  if (m.type === 'queue') {
    const q = directorQueue(m.tmdbId);
    title = 'Очередь режиссёра заполнена';
    body = `${queueContext(m.tmdbId)}<div class="row"><button class="btn primary" data-a="${on(() => applyQueueAdd(m.tmdbId, m.entryId, { allowExtra: true }))}">Добавить ещё одним (${q.films.length + 1}-м)</button></div><h3>Или заменить фильм в очереди</h3><div class="sub">Заменённый фильм останется учтённым. Его файлы, оценки и отметки сохранятся.</div><div class="list">${q.films.map((f) => `<div class="film"><div class="ftitle">${esc(titleOf(f))}</div><button class="mini" data-a="${on(() => applyQueueAdd(m.tmdbId, m.entryId, { replaceKey: f.key }))}">Заменить этот</button></div>`).join('')}</div><button class="btn ghost" data-a="${on(async () => {
      if (m.entryId != null) await doState('addEntryFilm', m.entryId, m.tmdbId, 'disk');
      ui.modal = null; render();
    })}">Только учитывать на диске</button>`;
  }
  if (m.type === 'loading') { title = m.title; body = '<div class="sub">Подожди немного.</div>'; }
  if (m.type === 'markup') {
    const d = ui.state.directors[m.dir];
    title = `Разметка: ${d.name}`;
    const fs = Object.values(ui.state.films).filter((f) => f.dir === m.dir).sort((a, b) => (a.year || 9999) - (b.year || 9999));
    const marks = [['Смотрел', 'watched', false], ['Не смотрел', 'candidate', false], ['Хочу', 'candidate', true], ['Не интересно', 'nointerest', false]];
    body = `<div class="sub">Только полнометражные режиссёрские работы, с начала карьеры. Разметить нужно один раз. У просмотренных фильмов можно поставить необязательную оценку от 1 до 10 — даже если смотрел их давно.</div><div class="list">${fs.map((f) => {
      const cur = f.status === 'queue' || f.status === 'reserve' ? 'queue' : f.status;
      return `<div class="film"><div class="fwrap">${posterHtml(f.poster)}<div><div class="ftitle">${f.year || '—'} · ${esc(titleOf(f))}</div><div class="fmeta">${filmMeta(f)}</div></div></div><div class="row" style="gap:4px">${cur === 'queue' ? '<span class="tag gold">В очереди</span>' : ''}${marks.map((k) => `<button class="mini ${cur === k[1] && !!f.wish === k[2] ? 'on' : ''}" data-a="${on(() => doState('markFilm', f.key, k[1], k[2]))}">${k[0]}</button>`).join('')}${markupRating(f)}</div></div>`;
    }).join('')}</div><button class="btn primary" data-a="${on(async () => { await doState('finishMarkup', m.dir); if (ui.state.directors[m.dir].needsChoice) openNext(m.dir); else { ui.modal = null; render(); } })}">Готово</button>`;
  }
  if (m.type === 'next') {
    const d = ui.state.directors[m.dir];
    title = `Следующий фильм: ${d.name}`;
    const fs = Object.values(ui.state.films).filter((f) => f.dir === m.dir && ['candidate', 'disk'].includes(f.status)).sort((a, b) => Number(b.wish) - Number(a.wish) || (m.sort === 'pop' ? (b.voteAverage * Math.log10(1 + b.voteCount)) - (a.voteAverage * Math.log10(1 + a.voteCount)) : (a.year || 9999) - (b.year || 9999)));
    body = `<div class="sub">В очереди меньше двух фильмов. Выбери один или два.</div><div class="row"><button class="mini ${m.sort === 'pop' ? 'on' : ''}" data-a="${on(() => { m.sort = 'pop'; render(); })}">Сначала известные</button><button class="mini ${m.sort === 'year' ? 'on' : ''}" data-a="${on(() => { m.sort = 'year'; render(); })}">По хронологии</button></div><div class="list">${fs.map((f) => { const sel = m.chosen.includes(f.key); return `<div class="film"><div class="fwrap">${posterHtml(f.poster)}<div><div class="ftitle">${filmLine(f)}</div><div class="fmeta">${filmMeta(f)}${f.wish ? ' · хочешь посмотреть' : ''}</div></div></div><button class="btn ${sel ? 'primary' : ''}" data-a="${on(() => { m.chosen = sel ? m.chosen.filter((x) => x !== f.key) : m.chosen.concat(f.key); render(); })}">${sel ? 'Выбран' : 'Выбрать'}</button></div>`; }).join('') || '<div class="sub">Больше фильмов не осталось.</div>'}</div><div class="row between"><div class="row"><button class="btn ghost" data-a="${on(() => { ui.modal = null; render(); })}">Отложить</button><button class="btn ghost" data-a="${on(async () => { await doState('ban', m.dir); ui.modal = null; render(); })}">Больше не предлагать этого режиссёра</button></div><button class="btn primary" data-a="${on(async () => { await doState('chooseNext', m.dir, m.chosen); ui.modal = null; render(); })}">Готово: выбрано ${m.chosen.length}</button></div>`;
  }
  if (m.type === 'add') {
    title = 'Добавить фильм или режиссёра';
    const r = m.results;
    body = `<div class="row"><input id="addq" class="field" aria-label="Поиск в TMDB" placeholder="Название или имя" value="${esc(m.q)}"><button class="btn primary" data-a="${on(async () => { m.results = await call('searchAdd', m.q); render(); })}">Найти</button></div>${r ? `<div class="list">${r.people.map((p) => `<div class="film"><div><div class="ftitle">${esc(p.name)}</div><div class="fmeta">Режиссёр${p.inLibrary ? ' · уже в библиотеке' : ''}</div></div><button class="btn primary" data-a="${on(async () => { ui.modal = { type: 'loading', title: 'Загружаю фильмографию' }; render(); const x = await doState('addDirector', { id: p.id, name: p.name }); await openNext(x.dirId); })}">Добавить режиссёра</button></div>`).join('')}${r.films.map((c) => `<div class="film"><div><div class="ftitle">${esc(c.title)}${c.year ? ` (${c.year})` : ''}</div><div class="fmeta">Фильм · ${esc(c.originalTitle || '')}</div></div><button class="btn primary" data-a="${on(async () => { await requestQueueAdd(c.id); })}">Добавить фильм</button></div>`).join('') || (r.people.length ? '' : '<div class="sub">Ничего не нашлось.</div>')}</div>` : ''}`;
  }
  return `<div class="shade"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row between"><h2>${esc(title)}</h2>${close}</div>${body}</div></div>`;
}

function menu() {
  if (!ui.menu) return '';
  const f = ui.state.films[ui.menu.key];
  if (!f) return '';
  const inNear = ui.state.near.some((e) => e.ids.includes(f.key));
  const status = async (s) => { const r = await doState('setFilmStatus', f.key, s); if (r.askDirector != null) openDirector(r.askDirector); };
  const items = [
    [inNear ? 'Убрать из ближайших' : 'Добавить на ближайший просмотр', () => doState(inNear ? 'removeNear' : 'addNear', f.key)],
    [f.rewatch ? 'Убрать из «Пересмотреть»' : 'Добавить в «Пересмотреть»', () => doState('toggleRewatch', f.key)],
    ['Посмотрел', () => status('watched')], ['Бросил', () => status('dropped')], ['Не нашёл', () => status('notfound')],
    ['Изменить название', () => { ui.menu = null; ui.modal = { type: 'rename', key: f.key }; render(); }],
    ...((ui.files.get(f.key) || []).length ? [['Открыть папку', () => { ui.menu = null; render(); call('openEntry', ui.files.get(f.key)[0].id); }]] : []),
    ['Открыть на Кинопоиске', () => { ui.menu = null; render(); call('openExternal', f.kpLink || kpSearch(f)); }],
    ['Разметить режиссёра', () => { ui.menu = null; openMarkup(f.dir); }],
  ];
  return `<div style="position:fixed;inset:0;z-index:30" data-a="${on(() => { ui.menu = null; render(); })}"></div><div class="menu" role="menu" style="left:${ui.menu.x}px;top:${ui.menu.y}px;max-height:calc(100vh - ${ui.menu.y+8}px);overflow-y:auto">${nearDirectorSummary(f.dir,f.key)}${items.map((i) => `<button class="mitem" role="menuitem" data-a="${on(i[1])}">${i[0]}</button>`).join('')}</div>`;
}

function renameModal() {
  const m = ui.modal;
  if (!m || m.type !== 'rename') return '';
  const f = ui.state.films[m.key];
  return `<div class="shade"><div class="modal" role="dialog" aria-modal="true" aria-label="Изменить название"><h2>Изменить название</h2><div class="sub">Оригинальное: ${esc(f.originalTitle || '')}. Твоё название сохранится только в программе.</div><input id="ren" class="field wide" aria-label="Название" value="${esc(titleOf(f))}"><div class="row"><button class="btn primary" data-a="${on(async () => { const v = document.getElementById('ren').value; ui.modal = null; await doState('setTitle', f.key, v); })}">Сохранить</button><button class="btn ghost" data-a="${on(() => { ui.modal = null; render(); })}">Отмена</button></div></div></div>`;
}

function fatal(err) {
  const msg = String((err && (err.stack || err.message)) || err);
  console.error(msg);
  $app.innerHTML = `<div class="main"><div class="center"><h1>Программа столкнулась с ошибкой</h1><div class="sub">Твои данные не пострадали. Пришли этот текст в чат:</div><div class="error" style="white-space:pre-wrap;user-select:text">${esc(msg)}</div></div></div>`;
}
window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => { if (!ui.state) fatal(e.reason); });

function render() {
  try { renderInner(); } catch (e) { fatal(e); }
}

function renderInner() {
  if (!ui.state) return;
  ui.files = fileIndex();
  Object.keys(actions).forEach((k) => delete actions[k]);
  // Перерисовка не должна сбрасывать положение прокрутки.
  const shadeBefore = document.querySelector('.shade');
  const shadeTop = shadeBefore ? shadeBefore.scrollTop : 0;
  const pageTop = window.scrollY;
  const focus = document.activeElement && document.activeElement.id;
  const caret = focus && document.activeElement.selectionStart;
  const gate = screenGate();
  let html;
  if (gate) html = `<div class="main">${gate}</div>`;
  else {
    const screens = { library, near, rewatch, morning, review, download, disks, night, 'night-prep': nightPrep };
    html = navHtml() + `<main class="main">${(screens[ui.screen] || library)()}</main>`;
  }
  const mdl = ui.modal && ui.modal.type.startsWith('night-') ? nightModal() : ui.modal && ui.modal.type === 'rename' ? renameModal() : modal();
  $app.innerHTML = `<div class="app">${html}${mdl}${menu()}${ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}${ui.toastAction ? `<button class="mini" data-a="${on(ui.toastAction.run)}">${esc(ui.toastAction.label)}</button>` : ''}</div>` : ''}</div>`;
  const shadeAfter = document.querySelector('.shade');
  if (shadeAfter && shadeBefore) shadeAfter.scrollTop = shadeTop;
  window.scrollTo(0, pageTop);
  if (focus) { const el = document.getElementById(focus); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) { /* поле без курсора */ } } }
  if (!gate && ui.screen === 'disks' && ui.diskTab === 'orphans') loadOrphans();
}

// Постер не загрузился: показываем заглушку, а не значок сломанной картинки.
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.classList.contains('poster')) {
    const d = document.createElement('div');
    d.className = `noposter ${e.target.classList.contains('big') ? 'big' : ''}`;
    d.textContent = 'нет постера';
    e.target.replaceWith(d);
  }
}, true);

document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-menu]');
  if (m) { openMenu(m.dataset.menu, e); return; }
  const a = e.target.closest('[data-a]');
  if (a && actions[a.dataset.a]) actions[a.dataset.a]();
});
function openMenu(key, e) {
  e.preventDefault();
  ui.menu = { key, x: Math.max(8, Math.min(e.clientX, innerWidth - 285)), y: Math.max(8, Math.min(e.clientY, innerHeight - 350)) };
  render();
}
document.addEventListener('contextmenu', (e) => {
  const f = e.target.closest('[data-film]');
  if (f) openMenu(f.dataset.film, e);
});
document.addEventListener('change', (e) => {
  const key = e.target.dataset.rating;
  if (key) doState('rate', key, e.target.value === '' ? null : Number(e.target.value)).catch(() => {});
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'libq') { ui.q = e.target.value; ui.shown = 40; render(); }
  if (e.target.id === 'addq') ui.modal.q = e.target.value;
  if (e.target.dataset.orpq) ui.orphanQ[e.target.dataset.orpq] = e.target.value;
  if (e.target.id === 'allconn') doState('setAllConnected', e.target.checked);
  if (e.target.dataset.revq) ui.reviewQ[e.target.dataset.revq] = e.target.value;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'addq') call('searchAdd', ui.modal.q).then((r) => { ui.modal.results = r; render(); });
  if (e.key === 'Enter' && e.target.dataset.revq) { const r = ui.review.find((x) => String(x.id) === e.target.dataset.revq); if (r) searchReview(r.id, r.title); }
  if (e.key === 'Escape' && ui.menu) { ui.menu = null; render(); }
});
let dragFrom = null;
document.addEventListener('dragstart', (e) => { const r = e.target.closest('[data-entry]'); if (r) dragFrom = r.dataset.entry; });
document.addEventListener('dragover', (e) => { if (e.target.closest('[data-entry]')) e.preventDefault(); });
document.addEventListener('drop', (e) => { const r = e.target.closest('[data-entry]'); if (r && dragFrom) { e.preventDefault(); doState('moveNear', dragFrom, Number(r.dataset.idx)); dragFrom = null; } });

bridge.onProgress((p) => { ui.progress = p; if (ui.state && ui.state.job && !['review', 'done'].includes(ui.state.job.phase)) render(); });
if (bridge.onScan) bridge.onScan((sc) => { ui.scan = { running: true, current: sc.current, found: sc.found }; if (ui.screen === 'disks') render(); });
bridge.onUpdate((u) => { ui.update = u; render(); });

(async function start() {
  ui.version = await bridge.call('version');
  ui.hasKey = await bridge.call('hasKey');
  ui.state = await bridge.call('getState');
  ui.review = ui.state.job ? await bridge.call('reviewList') : [];
  ui.progress = ui.state.job ? await bridge.call('progress') : null;
  render();
  maybeRescue();
  if ((ui.state.folders || []).length) runScan().catch(() => {});
}()).catch(fatal);
