'use strict';
function openDirectorNamesEditor(){ui.modal={type:'director-names',query:'',filter:'nonRussian',shown:20,filmCounts:{}};render();}
function nameDraftValue(d){
  const id=String(d.id),stored=ui.state.directorNameDrafts?.[id];
  return ui.namesLocal?.[id]||stored||{id,token:null,base:DirectorIdentity.snapshot(d),baseVersion:DirectorIdentity.version(d),name:d.name||'',surname:d.sortSurname||'',reviewed:false,selected:false};
}
function nameDraftExists(id){return !!(ui.namesLocal?.[id]||ui.state.directorNameDrafts?.[id]);}
function nameDraftStale(d,value=nameDraftValue(d)){return value.baseVersion!==DirectorIdentity.version(d);}
function editDirectorDraft(id,patch){
  const d=ui.state.directors[id];if(!d||ui.namesBusy)return;
  ui.namesLocal=ui.namesLocal||{};
  const value=ui.namesLocal[id]||{...nameDraftValue(d),seq:0,dirty:false,error:null};
  if(Object.hasOwn(patch,'name')||Object.hasOwn(patch,'surname')){value.reviewed=false;value.selected=false;}
  Object.assign(value,patch);value.seq++;value.dirty=true;value.error=null;ui.namesLocal[id]=value;
  ui.namesTimers=ui.namesTimers||{};clearTimeout(ui.namesTimers[id]);ui.namesTimers[id]=setTimeout(()=>{delete ui.namesTimers[id];queueDirectorDraft(id).catch(()=>{});},250);
  render();
}
function queueDirectorDraft(id){
  const value=ui.namesLocal?.[id];if(!value?.dirty)return ui.namesSaving||Promise.resolve();
  const input={name:value.name,surname:value.surname,reviewed:value.reviewed,selected:value.selected,baseVersion:value.baseVersion,token:value.token,revision:value.revision||null},seq=value.seq;
  value.dirty=false;ui.namesPending=(ui.namesPending||0)+1;
  ui.namesSaving=(ui.namesSaving||Promise.resolve()).catch(()=>{}).then(async()=>{
    input.token=ui.state.directorNameDrafts?.[id]?.token||input.token;input.revision=ui.state.directorNameDrafts?.[id]?.revision||input.revision;
    ui.state=await call('saveDirectorNameDraft',id,input);
    value.token=ui.state.directorNameDrafts[id].token;value.revision=ui.state.directorNameDrafts[id].revision;
    if(value.seq===seq)value.error=null;
  }).catch(e=>{value.error=String(e.message||e);throw e;}).finally(()=>{ui.namesPending--;if(ui.modal?.type.startsWith('director-names'))render();});
  return ui.namesSaving;
}
async function flushDirectorDrafts(){
  for(const [id,timer] of Object.entries(ui.namesTimers||{})){clearTimeout(timer);delete ui.namesTimers[id];}
  for(const [id,value] of Object.entries(ui.namesLocal||{}))if(value.dirty)queueDirectorDraft(id).catch(()=>{});
  await (ui.namesSaving||Promise.resolve());
  if(Object.values(ui.namesLocal||{}).some(v=>v.error))throw Error('Не все черновики сохранены. Повтори сохранение строки с ошибкой.');
}
async function closeDirectorNames(){if(ui.namesBusy)return;try{await flushDirectorDrafts();ui.modal=null;render();}catch(e){say(String(e.message||e));}}
async function openFilmCharacteristics(key,back=null){
  if(ui.namesBusy)return;
  if(back?.type==='director-names'){try{await flushDirectorDrafts();}catch(e){say(String(e.message||e));return;}}
  ui.menu=null;ui.modal={type:'night-tags',key,back};render();
}
async function namesAction(action){
  if(ui.namesBusy)return;ui.namesBusy=true;render();
  try{await flushDirectorDrafts();await action();}catch(e){try{ui.state=await bridge.call('getState');}catch{}say(String(e.message||e));}finally{ui.namesBusy=false;render();}
}
async function resetNameProposal(id,rebase=false){
  if(ui.namesBusy)return;
  const value={...nameDraftValue(ui.state.directors[id])};
  clearTimeout(ui.namesTimers?.[id]);if(ui.namesTimers)delete ui.namesTimers[id];
  if(ui.namesLocal?.[id])ui.namesLocal[id].dirty=false;
  ui.namesBusy=true;render();
  try{
    await (ui.namesSaving||Promise.resolve()).catch(()=>{});
    const saved=ui.state.directorNameDrafts?.[id];
    if(rebase){
      ui.state=await call('saveDirectorNameDraft',id,{name:value.name,surname:value.surname,reviewed:false,selected:false,token:saved?.token||null,revision:saved?.revision||null,baseVersion:saved?.baseVersion||DirectorIdentity.version(ui.state.directors[id])});
      ui.state=await call('rebaseDirectorNameDraft',id,ui.state.directorNameDrafts[id].token);
    }else if(saved)ui.state=await call('discardDirectorNameDraft',id,saved.token);
    if(ui.namesLocal)delete ui.namesLocal[id];
  }catch(e){try{ui.state=await bridge.call('getState');}catch{}say(String(e.message||e));}finally{ui.namesBusy=false;render();}
}
function directorEditorFilms(id){
  if(ui.namesIndexedFilms!==ui.state.films){
    ui.namesIndexedFilms=ui.state.films;ui.namesFilmIndex=new Map();ui.namesFilmSorted=new Set();
    for(const f of Object.values(ui.state.films))for(const key of new Set([f.dir,...(f.directorIds||[])].filter(x=>x!=null).map(String))){if(!ui.namesFilmIndex.has(key))ui.namesFilmIndex.set(key,[]);ui.namesFilmIndex.get(key).push(f);}
  }
  id=String(id);const films=ui.namesFilmIndex.get(id)||[];
  if(!ui.namesFilmSorted.has(id)){films.sort((a,b)=>Number(b.status==='queue')-Number(a.status==='queue')||(a.year||9999)-(b.year||9999)||titleOf(a).localeCompare(titleOf(b),'ru'));ui.namesFilmSorted.add(id);}
  return films;
}
function directorNamesModal(){
  const m=ui.modal;
  if(m.type==='director-names-apply'){
    const drafts=m.ids.map(id=>ui.state.directorNameDrafts?.[id]).filter(Boolean);
    const stale=drafts.length!==m.ids.length||drafts.some(v=>nameDraftStale(ui.state.directors[v.id],v)||v.token!==m.tokens[v.id]?.token||v.revision!==m.tokens[v.id]?.revision);
    return `<div class="shade"><div class="modal names-modal" role="dialog" aria-modal="true" aria-label="Применить имена"><h2>Применить имена (${drafts.length})</h2><div class="sub">Изменятся отображаемые имена и фамилии сортировки. ID TMDB, фильмы, оценки и очереди сохранятся.</div>${drafts.map(v=>`<div class="film"><div>${esc(ui.state.directors[v.id].name)} → <strong>${esc(v.name)}</strong><div class="sub">Фамилия для сортировки: ${esc(v.surname||'автоматически')} · TMDB №${esc(v.id)}</div></div></div>`).join('')}${stale?'<div class="error">Некоторые исходные имена изменились. Вернись и проверь предложения заново.</div>':''}<div class="row"><button class="btn primary" ${ui.namesBusy||stale?'disabled':''} data-a="${on(()=>namesAction(async()=>{ui.state=await call('applyDirectorNames',m.ids,m.tokens);m.ids.forEach(id=>{if(ui.namesLocal)delete ui.namesLocal[id];});ui.modal=m.back;}))}">Применить изменения</button><button class="btn" ${ui.namesBusy?'disabled':''} data-a="${on(()=>{ui.modal=m.back;render();})}">Назад</button></div></div></div>`;
  }
  if(m.type==='director-names-undo'){
    return `<div class="shade"><div class="modal" role="dialog" aria-modal="true" aria-label="Отмена имён"><h2>Отменить эту правку имён?</h2><div class="sub">Вернутся прежние имена этого применения. Изменения фильмов, оценок и очередей сохранятся. Если имя уже правили позднее, отмена не затрёт эту правку.</div><div class="row"><button class="btn primary" ${ui.namesBusy?'disabled':''} data-a="${on(()=>namesAction(async()=>{const batch=(ui.state.directorNameHistory||[]).find(b=>b.id===m.batchId);ui.state=await call('undoDirectorNames',m.batchId);batch.changes.forEach(c=>{if(ui.namesLocal)delete ui.namesLocal[c.id];});ui.modal=m.back;}))}">Отменить правку имён</button><button class="btn" data-a="${on(()=>{ui.modal=m.back;render();})}">Назад</button></div></div></div>`;
  }
  const norm=x=>String(x||'').toLowerCase().replace(/ё/g,'е');
  const q=norm(m.query).trim(),all=Object.values(ui.state.directors),selected=all.filter(d=>nameDraftExists(d.id)).map(nameDraftValue).filter(v=>v.selected&&v.reviewed);
  const list=all.filter(d=>m.filter==='all'||m.filter==='nonRussian'&&!DirectorIdentity.hasCyrillic(d.name)||m.filter==='unreviewed'&&!DirectorIdentity.reviewed(d)||m.filter==='drafts'&&nameDraftExists(d.id)).filter(d=>!q||[...directorNames(d),nameDraftValue(d).name,...directorEditorFilms(d.id).map(titleOf)].some(v=>norm(v).includes(q))).sort((a,b)=>a.name.localeCompare(b.name,'ru')||String(a.id).localeCompare(String(b.id)));
  const unsaved=(ui.namesPending||0)||Object.values(ui.namesLocal||{}).some(v=>v.dirty);
  const errors=Object.values(ui.namesLocal||{}).some(v=>v.error);
  const rows=list.slice(0,m.shown).map(d=>{
    const id=String(d.id),v=nameDraftValue(d),has=nameDraftExists(id),stale=has&&nameDraftStale(d,v),films=directorEditorFilms(id),limit=m.filmCounts?.[id]||3;
    const aliases=[...new Set(directorNames(d))].filter(n=>n!==d.name).sort((a,b)=>Number(DirectorIdentity.hasCyrillic(b))-Number(DirectorIdentity.hasCyrillic(a))||a.localeCompare(b,'ru'));
    return `<section class="card name-editor-row" data-director-row="${esc(id)}"><div class="row between"><div><h3>${esc(d.name)}</h3><div class="sub">TMDB: ${esc(d.tmdbName||d.name)} · №${esc(id)} ${DirectorIdentity.reviewed(d)?'· Проверено':''}</div></div><button class="mini" ${ui.namesBusy?'disabled':''} data-a="${on(()=>call('openExternal',`https://www.themoviedb.org/person/${id}`))}">Профиль TMDB</button></div><div class="name-editor-fields"><label>Отображаемое имя<input class="field wide" id="name-edit-${id}" data-director-field="name" data-director-id="${id}" maxlength="150" value="${esc(v.name)}" ${ui.namesBusy?'disabled':''}></label><label>Фамилия для сортировки<input class="field wide" id="surname-edit-${id}" data-director-field="surname" data-director-id="${id}" maxlength="150" value="${esc(v.surname)}" placeholder="Последнее слово, если не указана" ${ui.namesBusy?'disabled':''}></label></div>${has?`<div class="sub">${esc(v.base.name||d.name)} → <strong>${esc(v.name||'Имя не введено')}</strong></div>`:''}${stale?`<div class="error">Имя изменилось после начала правки. Проверь предложение заново. <button class="mini" data-a="${on(()=>resetNameProposal(id,true))}">Обновить исходное имя</button></div>`:''}${v.error?`<div class="error">${esc(v.error)} <button class="mini" data-a="${on(()=>{v.dirty=true;queueDirectorDraft(id).catch(()=>{});})}">Повторить сохранение</button></div>`:''}<div class="row"><label class="sub"><input type="checkbox" data-director-check="${id}" ${v.reviewed?'checked':''} ${!v.name.trim()||stale||ui.namesBusy?'disabled':''}> Проверено — выбрать для применения</label>${has?`<button class="mini" ${ui.namesBusy?'disabled':''} data-a="${on(()=>resetNameProposal(id))}">Сбросить предложение</button>`:''}<button class="mini" ${ui.namesBusy?'disabled':''} data-a="${on(()=>namesAction(async()=>{const r=await call('suggestDirectorNames',id);ui.state=r.state;}))}">Загрузить варианты TMDB</button></div>${aliases.length?`<div class="row"><span class="sub">Выбрать вариант:</span>${aliases.map(n=>`<button class="mini" ${ui.namesBusy?'disabled':''} data-a="${on(()=>editDirectorDraft(id,{name:n}))}">${esc(n)}</button>`).join('')}</div>`:''}<div class="list">${films.slice(0,limit).map(f=>`<div class="film"><div class="fwrap">${posterHtml(f.poster)}<div><div class="ftitle">${filmLine(f)}</div><div class="sub">${f.runtime?f.runtime+' мин':''}</div></div></div><button class="mini" ${ui.namesBusy?'disabled':''} data-a="${on(()=>openFilmCharacteristics(f.key,m))}">Характеристики фильма</button></div>`).join('')||'<div class="sub">Связанных фильмов пока нет.</div>'}</div>${films.length>limit?`<button class="mini" data-a="${on(()=>{m.filmCounts=m.filmCounts||{};m.filmCounts[id]=limit===3?20:limit+20;render();})}">Показать ещё фильмы (${films.length-limit})</button>`:''}</section>`;
  }).join('');
  const history=ui.state.directorNameHistory||[];
  return `<div class="shade"><div class="modal names-modal" role="dialog" aria-modal="true" aria-label="Имена режиссёров"><div class="row between"><h2>Имена режиссёров</h2><button class="mini" ${ui.namesBusy?'disabled':''} data-a="${on(closeDirectorNames)}">Закрыть</button></div><div class="sub">Русские имена можно вводить вручную или выбирать из вариантов TMDB. Все прежние написания остаются в поиске. Черновики сохраняются отдельно от библиотеки.</div><div class="name-editor-toolbar"><input id="director-editor-search" class="field" aria-label="Поиск режиссёра или фильма" placeholder="Имя или фильм" value="${esc(m.query)}"><select id="director-editor-filter" class="field" aria-label="Фильтр имён">${nOptions([['nonRussian','Без кириллицы'],['unreviewed','Ещё не проверены'],['drafts','Есть черновик'],['all','Все режиссёры']],m.filter)}</select><button class="btn" ${ui.namesBusy?'disabled':''} data-a="${on(()=>namesAction(async()=>{}))}">Сохранить черновик</button><button class="btn primary" ${!selected.length||ui.namesBusy||errors?'disabled':''} data-a="${on(()=>namesAction(async()=>{const picked=Object.values(ui.state.directorNameDrafts||{}).filter(v=>v.selected&&v.reviewed);ui.modal={type:'director-names-apply',back:m,ids:picked.map(v=>v.id),tokens:Object.fromEntries(picked.map(v=>[v.id,{token:v.token,revision:v.revision}]))};}))}">Применить выбранные (${selected.length})</button></div><div class="sub" role="status">${ui.namesBusy?'Выполняю действие…':errors?'Не все черновики сохранены':unsaved?'Сохраняю черновик…':'Черновик сохранён'} · найдено ${list.length} из ${all.length} · выбранные предложения применяются из всего списка</div><div class="list">${rows||'<div class="sub">По этим условиям режиссёры не найдены.</div>'}</div>${list.length>m.shown?`<button class="btn" data-a="${on(()=>{m.shown+=20;render();})}">Показать ещё режиссёров</button>`:''}${history.length?`<details><summary>История применения имён (${history.length})</summary><div class="list">${[...history].reverse().slice(0,10).map(b=>`<div class="film"><div>${esc(new Date(b.at).toLocaleString('ru-RU'))} · имён: ${b.changes.length}</div><button class="mini" data-a="${on(()=>{ui.modal={type:'director-names-undo',batchId:b.id,back:m};render();})}">Отменить эту правку</button></div>`).join('')}</div></details>`:''}</div></div>`;
}
document.addEventListener('input',e=>{
  if(e.target.dataset.directorField)editDirectorDraft(e.target.dataset.directorId,{[e.target.dataset.directorField]:e.target.value});
  if(e.target.id==='director-editor-search'){ui.modal.query=e.target.value;ui.modal.shown=20;render();}
});
document.addEventListener('change',e=>{
  if(e.target.dataset.directorCheck)editDirectorDraft(e.target.dataset.directorCheck,{reviewed:e.target.checked,selected:e.target.checked});
  if(e.target.id==='director-editor-filter'){ui.modal.filter=e.target.value;ui.modal.shown=20;render();}
});
