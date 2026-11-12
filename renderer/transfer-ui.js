'use strict';
const transferBytes = n => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : gb(n);
const transferPhases = { preparing: 'Проверка условий переноса', copying: 'Копирование', verifying: 'Проверка исходника и копии (SHA-256)', deleting: 'Удаление проверенного исходника', restoring: 'Восстановление исходника', completed: 'Перенос завершён', failed: 'Перенос остановлен' };

async function previewTransfer(nid, index, entryId) {
  if (ui.transferBusy || ui.transferPreviewBusy) return;
  ui.transferPreviewBusy = true; render();
  try {
    const plan = await call('previewNightTransfer', nid, index, entryId);
    ui.modal = { type: 'night-transfer', plan, confirmed: false };
  } catch { /* call already displays the error */ } finally { ui.transferPreviewBusy = false; render(); }
}
async function executeTransfer() {
  const modal = ui.modal;
  if (ui.transferBusy || !modal?.confirmed) return;
  ui.transferBusy = true; ui.transferProgress = null; ui.modal = null; render();
  try {
    const result = await call('executeNightTransfer', modal.plan.token);
    ui.state = result.state;
    if (!result.ok) say(result.sourceRestored ? 'Перенос остановлен. Исходник сохранён; подробности в журнале.' : 'Требуется восстановление. Проверенную копию не удаляй.');
    else say('Фильм перенесён в «Сегодня».');
  } catch { /* preflight errors are displayed by call */ } finally { ui.transferBusy = false; await refresh().catch(()=>{}); }
}
function transferModal() {
  const m = ui.modal, p = m.plan;
  return `<div class="shade"><div class="modal" role="dialog" aria-modal="true" aria-label="Предпросмотр переноса"><div class="row between"><h2>Перенести в «Сегодня»</h2><button class="mini" data-a="${on(()=>{ui.modal=null;render();})}">Отмена</button></div><h3>${esc(p.title)}</h3><div class="sub">${p.isFile?'Файл и внешние субтитры с тем же началом имени в его папке':'Вся папка фильма, включая вложенные файлы, субтитры и пустые папки'}. Имена сохраняются.</div><p class="path">Источник: ${esc(p.source)}<br>Назначение: ${esc(p.target)}</p><p>${p.files.length} файлов · ${transferBytes(p.bytes)} · папок: ${p.dirs.length}</p><details><summary>Полный список копирования</summary>${p.files.map(f=>`<div class="card path">${esc(f.source)}<br>→ ${esc(f.target)} · ${transferBytes(f.size)}</div>`).join('')}${p.dirs.length?`<div class="sub">Папки: ${p.dirs.map(esc).join('<br>')}</div>`:''}</details><p>Сначала копирование, затем независимая проверка SHA-256 исходника и копии. Только после успешной проверки удаляется исходник и обновляется библиотека. Перезапись запрещена.</p><p class="sub">При ошибке копирования или проверки исходник не удаляется. При ошибке удаления программа восстанавливает уже удалённые части из проверенной копии. Если диск недоступен, восстановление можно повторить из журнала. Созданная копия при ошибке остаётся для проверки и не учитывается сканером.</p><p class="sub">Корзиной #recycle управляет Synology. Программа её не очищает и не может проверить, попал ли туда удалённый файл.</p><label><input type="checkbox" id="transfer-confirm" ${m.confirmed?'checked':''}> Подтверждаю выбранный фильм, список файлов и удаление исходника после проверки копии</label><div class="row"><button class="btn primary" ${!m.confirmed?'disabled':''} data-a="${on(executeTransfer)}">Копировать → проверить → удалить исходник</button></div></div></div>`;
}
function transferPanel(nid) {
  const jobs = (ui.state.nightTransfers || []).filter(j => j.nid === nid && j.status !== 'dismissed');
  const p = ui.transferProgress;
  const progress = ui.transferBusy && !p ? '<div class="notice" role="status">Проверяю условия переноса…</div>' : ui.transferBusy && p?.nid === nid ? `<div class="card" role="status" aria-live="polite"><h3>${esc(transferPhases[p.phase] || p.phase)}</h3>${['copying','verifying','deleting'].includes(p.phase)?`<progress max="${Math.max(1,p.total)}" value="${p.done}"></progress> ${transferBytes(p.done)} / ${transferBytes(p.total)}<div class="path">${esc(p.current)}</div>${p.phase!=='deleting'?`<button class="mini" ${ui.transferCancelling?'disabled':''} data-a="${on(async()=>{ui.transferCancelling=true;render();try{await call('cancelNightTransfer');}catch{ui.transferCancelling=false;render();}})}">${ui.transferCancelling?'Останавливаю…':'Отменить до удаления исходника'}</button>`:'<div class="sub">Дождись завершения. Не отключай диски.</div>'}`:'<div class="sub">Дождись завершения. Не отключай диски.</div>'}</div>` : '';
  return progress + jobs.slice().reverse().map(j => {
    if (ui.transferBusy && j.id === p?.id) return '';
    if (j.status === 'completed') return `<div class="notice">Перенесено в «Сегодня»: <span class="path">${esc(j.target)}</span></div>`;
    const interrupted = !['failed','needs-recovery'].includes(j.status);
    return `<section class="card"><h3>${interrupted?'Прерванный перенос':j.sourceRestored?'Перенос остановлен — исходник сохранён':'Требуется восстановление исходника'}</h3><div class="error">${esc(j.error||'Приложение закрылось до завершения операции.')}</div>${j.recoveryError?`<div class="error">${esc(j.recoveryError)}</div>`:''}${j.persistenceError?`<div class="error">Не удалось сохранить журнал: ${esc(j.persistenceError)}</div>`:''}<div class="path">Источник: ${esc(j.source)}<br>Созданная копия: ${esc(j.target)}</div><p class="sub">Копия может быть неполной и исключена из сканирования. Не удаляй её до восстановления и проверки исходника. Повторный перенос не перезапишет её; после восстановления лишние копии можно убрать вручную.</p>${!j.sourceRestored?`<button class="btn" ${ui.transferBusy?'disabled':''} data-a="${on(async()=>{ui.transferBusy=true;render();try{const r=await call('recoverNightTransfer',j.id);ui.state=r.state;say('Исходник восстановлен. Созданная копия оставлена для проверки.');}catch{/* call displays the error */}finally{ui.transferBusy=false;await refresh().catch(()=>{});}})}">Проверить и восстановить исходник</button>`:`<button class="mini" ${ui.transferBusy?'disabled':''} data-a="${on(()=>doState('dismissNightTransfer',j.id).catch(()=>{}))}">Копию убрал вручную — закрыть запись</button>`}</section>`;
  }).join('');
}
document.addEventListener('change', e => {
  if (e.target.id === 'transfer-confirm' && ui.modal?.type === 'night-transfer') { ui.modal.confirmed=e.target.checked;render(); }
});
