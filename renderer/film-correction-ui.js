'use strict';
function openFilmCorrection(key){
  const f=ui.state.films[key];if(!f)return;
  ui.modal={type:'film-correction',key,q:`${titleOf(f)}${f.year?' ('+f.year+')':''}`,results:null,preview:null,busy:false,keepTitle:true,keepFiles:false};render();
}
async function correctionSearch(){
  const m=ui.modal;if(m?.type!=='film-correction'||m.busy)return;
  m.q=document.getElementById('correction-query').value;m.busy=true;render();
  try{m.results=await call('searchFilmCorrection',m.key,m.q);}finally{m.busy=false;if(ui.modal===m)render();}
}
async function correctionPreview(id){
  const m=ui.modal;if(m?.type!=='film-correction'||m.busy)return;m.busy=true;render();
  try{m.preview=await call('previewFilmCorrection',m.key,id);m.keepTitle=true;m.keepFiles=false;}finally{m.busy=false;if(ui.modal===m)render();}
}
async function correctionApply(){
  const m=ui.modal;if(m?.type!=='film-correction'||m.busy||!m.preview)return;m.busy=true;render();
  try{
    const r=await call('applyFilmCorrection',m.preview.token,{confirmed:true,keepTitle:m.keepTitle,keepFiles:m.keepFiles});
    ui.state=r.state;ui.nightEdit=ui.state.nightDraft?JSON.parse(JSON.stringify(ui.state.nightDraft)):null;ui.menu=null;ui.modal=null;
    await loadDiskExtras();say('Фильм исправлен. Архивные совпадения сняты; файловые связи обработаны по выбранной настройке.');
  }finally{m.busy=false;render();}
}
function filmCorrectionModal(){
  const m=ui.modal,f=ui.state.films[m.key];if(!f)return '';
  const disabled=m.busy?'disabled':'';
  const current=`<section class="card"><h3>Сейчас в библиотеке</h3><div class="fwrap">${posterHtml(f.poster)}<div><div>${filmLine(f)}</div><div class="sub">TMDB: ${esc(f.tmdbTitle||'—')} · ${esc(f.originalTitle||'—')}</div><div class="sub">${esc(ui.state.directors[f.dir]?.name||'')} · ID ${esc(f.tmdbId)}</div></div></div></section>`;
  let body;
  if(m.preview){
    const p=m.preview,t=p.target;
    body=`${current}<section class="card"><h3>Правильный фильм</h3><div class="fwrap">${posterHtml(t.poster)}<div><h3>${esc(t.tmdbTitle)} (${esc(t.year||'—')})</h3><div class="sub">${esc(t.originalTitle)} · ${esc(t.directors.map(d=>d.name).join(', '))} · ${t.runtime||'?'} мин · ID ${t.tmdbId}</div></div></div><p>${esc(t.overview||'Нет описания.')}</p></section><p>Исправятся запись TMDB, постер, год и режиссёр. Просмотры, оценки, очередь, ближайшие и отметки сохранятся; ссылки в планах ночей обновятся. Файлы не переименовываются и не перемещаются.</p><label class="row"><input id="correction-keep-title" type="checkbox" ${m.keepTitle?'checked':''} ${disabled}> Сохранить моё название «${esc(f.userTitle||'не задано')}»</label><p class="sub">Если снять галочку, будет использоваться название правильного фильма из TMDB.</p><h3>Обычные файловые связи: ${p.files.length}</h3>${p.files.map(e=>`<div class="path">${esc(e.path)}</div>`).join('')}<label class="row"><input id="correction-keep-files" type="checkbox" ${m.keepFiles?'checked':''} ${disabled}> Эти обычные файлы точно относятся к выбранному фильму — сохранить связи</label><p class="sub">Без галочки файлы останутся на диске и вернутся в «Нужно разобрать». Старые автоматические связи по названиям будут сброшены.</p><h3>Архивные совпадения: ${p.archive.length}</h3>${p.archive.map(e=>`<div class="path">${esc(e.path)}</div>`).join('')}<p class="sub">Эти совпадения будут сняты. Пути сохранятся в каталоге, файлы не меняются. После исправления можно заново проверить резервный NAS. Исправление не объединяет разные записи библиотеки.</p><div class="row"><button class="btn" ${disabled} data-a="${on(()=>{m.preview=null;render();})}">Назад к поиску</button><button class="btn primary" ${disabled} data-a="${on(correctionApply)}">${m.busy?'Сохраняю…':'Подтверждаю — исправить фильм'}</button></div>`;
  }else{
    body=`${current}<div class="row"><input class="field wide" id="correction-query" aria-label="Название, год или ссылка TMDB" value="${esc(m.q)}" placeholder="Название, год или ссылка TMDB" ${disabled}><button class="btn primary" ${disabled} data-a="${on(correctionSearch)}">${m.busy?'Загружаю…':'Найти правильный фильм'}</button></div>${m.results?`<div class="list">${m.results.map(t=>`<section class="card"><div class="fwrap">${posterHtml(t.poster)}<div><h3>${esc(t.title)} (${esc(t.year||'—')})</h3><div class="sub">${esc(t.originalTitle)} · ${esc(t.directors.map(d=>d.name).join(', '))} · ${t.runtime||'?'} мин · ID ${t.id}</div></div></div><p>${esc(t.overview||'Нет описания.')}</p>${t.inLibrary?'<p class="sub">Уже есть отдельной записью в библиотеке. Автоматическое объединение отключено.</p>':''}<button class="btn" ${m.busy||t.inLibrary?'disabled':''} data-a="${on(()=>correctionPreview(t.id))}">Выбрать — предпросмотр исправления</button></section>`).join('')||'<p>Ничего не найдено. Попробуй оригинальное название или ссылку TMDB.</p>'}</div>`:''}`;
  }
  return `<div class="shade"><div class="modal" role="dialog" aria-modal="true" aria-label="Исправить фильм"><div class="row between"><h2>Исправить фильм</h2><button class="mini" ${disabled} data-a="${on(()=>{ui.modal=null;render();})}">Отмена</button></div>${body}</div></div>`;
}
document.addEventListener('change',e=>{if(ui.modal?.type!=='film-correction'||ui.modal.busy)return;if(e.target.id==='correction-keep-title')ui.modal.keepTitle=e.target.checked;if(e.target.id==='correction-keep-files')ui.modal.keepFiles=e.target.checked;});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='correction-query'){e.preventDefault();correctionSearch().catch(()=>{});}});

document.addEventListener('input',e=>{if(e.target.id==='correction-query'&&ui.modal?.type==='film-correction')ui.modal.q=e.target.value;});
