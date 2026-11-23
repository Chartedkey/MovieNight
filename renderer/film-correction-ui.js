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
    const r=await call('applyFilmCorrection',m.preview.token,{confirmed:true,keepTitle:m.keepTitle,keepFiles:m.keepFiles,mergeConfirmed:!!m.preview.existing,useExisting:!!m.preview.existing});
    ui.state=r.state;ui.nightEdit=ui.state.nightDraft?JSON.parse(JSON.stringify(ui.state.nightDraft)):null;ui.menu=null;ui.modal=null;
    await loadDiskExtras();
    if(r.merged){
      const f=ui.state.films[r.filmKey],pending=ArchiveCatalog.pending(ui.state).some(x=>x.key===r.filmKey),hits=ArchiveCatalog.hits(ui.state,r.filmKey);
      const location=!['queue','reserve'].includes(f.status)?'Фильм больше не входит в «Скачать» по выбранному статусу.':!pending?'Обычная копия уже есть — фильм убран из «Скачать».':hits.some(e=>e.confirmedKey===r.filmKey)?'Фильм остался в «Найдено на резервном NAS».':hits.length?'Фильм остался в «Возможно найдено — проверить».':'Фильм остался в «Не найдено — скачать».';
      say('Записи объединены. '+location);
    }else say('Фильм исправлен. Архивные совпадения сняты; файловые связи обработаны по выбранной настройке.');
  }finally{m.busy=false;render();}
}
function mergeValue(field,value){
  if(field==='status')return ({queue:'В очереди',reserve:'В запасе',disk:'Учтён на диске',candidate:'Только фильмография',watched:'Просмотрен',dropped:'Брошен',notfound:'Не найден',nointerest:'Не интересно'})[value]||String(value);
  if(value===null)return field==='rating'?'Без оценки':field==='userTitle'?'Название TMDB':'Не задано';
  if(typeof value==='boolean')return value?'Да':'Нет';
  const labels={unknown:'Не определено',light:'Лёгкая',medium:'Средняя',heavy:'Тяжёлая',easy:'Без напряжения',focused:'Требует внимания',noir:'Нуар',neonoir:'Неонуар'};
  if(Array.isArray(value))return value.length?value.map(x=>field.startsWith('nightTags.')?labels[x]||x:x).join(', '):'Не отмечено';
  if(typeof value==='object')return JSON.stringify(value);
  return field.startsWith('nightTags.')?labels[value]||String(value):String(value);
}
async function correctionReject(){
  const m=ui.modal;if(m?.type!=='film-correction'||m.busy||!m.preview?.existing)return;
  m.busy=true;render();
  try{ui.state=await call('rejectFilmCorrection',m.preview.token);ui.modal=null;ui.screen='download';say('Фильм оставлен в «Нужно разобрать» в разделе «Скачать».');}finally{m.busy=false;render();}
}
function mergeReview(m){
  const p=m.preview,e=p.existing,t=p.target;
  const location=p.targetFiles.length?'Есть копия на обычном диске — фильм уйдёт из «Скачать».':!['queue','reserve'].includes(e.status)?'Фильм не входит в «Скачать» по статусу разобранной карточки.':p.targetArchive.some(e=>e.confirmed)?'Останется в «Найдено на резервном NAS».':p.targetArchive.length?'Останется в «Возможно найдено — проверить».':'Копия пока не найдена — останется в «Скачать».';
  return `<section class="card"><h3>Это тот же фильм?</h3><div class="fwrap">${posterHtml(t.poster||e.poster)}<div><h3>${filmLine(e)}</h3><div class="sub">${esc(t.originalTitle)} · ${esc(t.directors.map(d=>d.name).join(', '))} · ID ${e.tmdbId}</div><div class="sub">${esc(mergeValue('status',e.status))} · оценка: ${esc(mergeValue('rating',e.rating??null))}</div></div></div><p>${esc(location)}</p>${p.targetFiles.map(e=>`<div class="path">${esc(e.path)}</div>`).join('')}<p>Сохраним название, оценку и отметки этой разобранной карточки. Истории просмотров обеих записей объединим.</p><details><summary>Что будет со связями и планами</summary><p class="sub">Файлы не меняются. Связи разобранной карточки сохранятся. Файлы ошибочной записи вернутся в «Диски → Нужно разобрать», её архивные совпадения будут сняты. Старые результаты ночей останутся историей без возможности отмены; план с обеими карточками потребуется пересобрать.</p></details></section><div class="row"><button class="btn primary" ${m.busy?'disabled':''} data-a="${on(correctionApply)}">${m.busy?'Сохраняю…':'Да, это он'}</button><button class="btn" ${m.busy?'disabled':''} data-a="${on(correctionReject)}">Нет — в разбор</button></div>`;
}
function filmCorrectionModal(){
  const m=ui.modal,f=ui.state.films[m.key];if(!f)return '';
  const disabled=m.busy?'disabled':'';
  const current=`<section class="card"><h3>Сейчас в библиотеке</h3><div class="fwrap">${posterHtml(f.poster)}<div><div>${filmLine(f)}</div><div class="sub">TMDB: ${esc(f.tmdbTitle||'—')} · ${esc(f.originalTitle||'—')}</div><div class="sub">${esc(ui.state.directors[f.dir]?.name||'')} · ID ${esc(f.tmdbId)}</div><div class="sub">Статус: ${esc(mergeValue('status',f.status))} · оценка: ${esc(mergeValue('rating',f.rating??null))} · записей просмотра: ${(f.watched||[]).length}</div></div></section>`;
  let body;
  if(m.preview){
    const p=m.preview,t=p.target;
    const titleChoice=`<p>Исправятся запись TMDB, постер, год и режиссёр. Просмотры, оценки, очередь, ближайшие и отметки сохранятся; ссылки в планах ночей обновятся.</p><label class="row"><input id="correction-keep-title" type="checkbox" ${m.keepTitle?'checked':''} ${disabled}> Сохранить моё название «${esc(f.userTitle||'не задано')}»</label><p class="sub">Если снять галочку, будет использоваться название правильного фильма из TMDB.</p>`;
    body=p.existing?`${current}${mergeReview(m)}`:`${current}<section class="card"><h3>Правильный фильм TMDB</h3><div class="fwrap">${posterHtml(t.poster)}<div><h3>${esc(t.tmdbTitle)} (${esc(t.year||'—')})</h3><div class="sub">${esc(t.originalTitle)} · ${esc(t.directors.map(d=>d.name).join(', '))} · ${t.runtime||'?'} мин · ID ${t.tmdbId}</div></div></div><p>${esc(t.overview||'Нет описания.')}</p></section>${titleChoice}<p>Файлы не удаляются, не переименовываются и не перемещаются.</p><h3>Обычные файловые связи исправляемой записи: ${p.files.length}</h3>${p.files.map(e=>`<div class="path">${esc(e.path)}</div>`).join('')}<label class="row"><input id="correction-keep-files" type="checkbox" ${m.keepFiles?'checked':''} ${disabled}> Эти обычные файлы точно относятся к выбранному фильму — сохранить связи</label><p class="sub">Без галочки файлы останутся на диске и вернутся в «Нужно разобрать»; игнорируемые останутся игнорируемыми. Старые автоматические связи исправляемой записи будут сброшены.</p><h3>Архивные совпадения исправляемой записи: ${p.archive.length}</h3>${p.archive.map(e=>`<div class="path">${esc(e.path)}</div>`).join('')}<p class="sub">Эти ошибочные связи будут сняты. Пути сохранятся в каталоге, файлы не меняются. Подтверждённые архивные связи правильной записи сохранятся.</p><div class="row"><button class="btn" ${disabled} data-a="${on(()=>{m.preview=null;render();})}">Назад к поиску</button><button class="btn primary" ${m.busy?'disabled':''} data-a="${on(correctionApply)}">${m.busy?'Сохраняю…':'Подтверждаю — исправить фильм'}</button></div>`;
  }else{
    body=`${current}<div class="row"><input class="field wide" id="correction-query" aria-label="Название, год или ссылка TMDB" value="${esc(m.q)}" placeholder="Название, год или ссылка TMDB" ${disabled}><button class="btn primary" ${disabled} data-a="${on(correctionSearch)}">${m.busy?'Загружаю…':'Найти правильный фильм'}</button></div>${m.results?`<div class="list">${m.results.map(t=>`<section class="card"><div class="fwrap">${posterHtml(t.poster)}<div><h3>${esc(t.title)} (${esc(t.year||'—')})</h3><div class="sub">${esc(t.originalTitle)} · ${esc(t.directors.map(d=>d.name).join(', '))} · ${t.runtime||'?'} мин · ID ${t.id}</div></div></div><p>${esc(t.overview||'Нет описания.')}</p>${t.inLibrary?'<p class="sub">Уже есть в библиотеке. Проверим, тот ли это фильм.</p>':''}<button class="btn" ${disabled} data-a="${on(()=>correctionPreview(t.id))}">${t.inLibrary?'Выбрать — предпросмотр объединения':'Выбрать — предпросмотр исправления'}</button></section>`).join('')||'<p>Ничего не найдено. Попробуй оригинальное название или ссылку TMDB.</p>'}</div>`:''}`;
  }
  return `<div class="shade"><div class="modal" role="dialog" aria-modal="true" aria-label="Исправить фильм"><div class="row between"><h2>${m.preview?.existing?'Объединить записи':'Исправить фильм'}</h2><button class="mini" ${disabled} data-a="${on(()=>{ui.modal=null;render();})}">Отмена</button></div>${body}</div></div>`;
}
document.addEventListener('change',e=>{
  const m=ui.modal;if(m?.type!=='film-correction'||m.busy)return;
  if(e.target.id==='correction-keep-title')m.keepTitle=e.target.checked;
  if(e.target.id==='correction-keep-files')m.keepFiles=e.target.checked;
});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='correction-query'){e.preventDefault();correctionSearch().catch(()=>{});}});
document.addEventListener('input',e=>{if(e.target.id==='correction-query'&&ui.modal?.type==='film-correction')ui.modal.q=e.target.value;});
