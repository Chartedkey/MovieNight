'use strict';
const {randomUUID}=require('node:crypto');
const I=require('./director-identity');
const unique=names=>[...new Set(names.filter(n=>typeof n==='string'&&n.trim()).map(n=>n.trim()))];
function director(service,id){id=String(id);if(!/^\d+$/.test(id)||!Object.hasOwn(service.state.directors,id))throw Error('Режиссёр не найден.');return service.state.directors[id];}
function text(value,label){if(typeof value!=='string'||value.trim().length>150)throw Error(`${label}: не больше 150 символов.`);return value.trim();}
function restore(d,original){Object.keys(d).forEach(k=>delete d[k]);Object.assign(d,original);}
function transaction(service,records,run){
  const before=records.map(d=>[d,{...d}]),drafts=service.state.directorNameDrafts,history=service.state.directorNameHistory;
  try{run();service.save();}catch(e){before.forEach(([d,old])=>restore(d,old));service.state.directorNameDrafts=drafts;service.state.directorNameHistory=history;throw e;}
}
const directorNameMethods={
  saveDirectorNameDraft(id,input){
    const d=director(this,id);id=String(id);
    const name=text(input.name,'Имя'),surname=text(input.surname,'Фамилия');
    if(typeof input.reviewed!=='boolean'||typeof input.selected!=='boolean'||input.selected&&!input.reviewed||input.reviewed&&!name)throw Error('Сначала проверь и заполни имя.');
    const drafts=this.state.directorNameDrafts||{};const old=drafts[id];
    if(old?(input.token!==old.token||input.revision!==old.revision||input.baseVersion!==old.baseVersion):(input.token!=null||input.baseVersion!==I.version(d)))throw Error('Черновик или имя уже изменились. Открой актуальное предложение заново.');
    const draft={id,token:old?.token||randomUUID(),revision:randomUUID(),base:old?.base||I.snapshot(d),baseVersion:old?.baseVersion||I.version(d),name,surname,reviewed:input.reviewed,selected:input.selected};
    const before=this.state.directorNameDrafts;this.state.directorNameDrafts={...drafts,[id]:draft};
    try{this.save();}catch(e){this.state.directorNameDrafts=before;throw e;}
    return this.state;
  },
  discardDirectorNameDraft(id,token){
    director(this,id);id=String(id);const old=this.state.directorNameDrafts?.[id];if(!old||old.token!==token)throw Error('Черновик уже изменился.');
    const before=this.state.directorNameDrafts;this.state.directorNameDrafts={...before};delete this.state.directorNameDrafts[id];
    try{this.save();}catch(e){this.state.directorNameDrafts=before;throw e;}return this.state;
  },
  rebaseDirectorNameDraft(id,token){
    const d=director(this,id);id=String(id);const old=this.state.directorNameDrafts?.[id];if(!old||old.token!==token)throw Error('Черновик уже изменился.');
    const before=this.state.directorNameDrafts;
    this.state.directorNameDrafts={...before,[id]:{...old,token:randomUUID(),revision:randomUUID(),base:I.snapshot(d),baseVersion:I.version(d),reviewed:false,selected:false}};
    try{this.save();}catch(e){this.state.directorNameDrafts=before;throw e;}return this.state;
  },
  applyDirectorNames(ids,tokens){
    if(!Array.isArray(ids)||!ids.length)throw Error('Выбери проверенные предложения.');
    const picked=[...new Set(ids.map(String))].map(id=>{
      const d=director(this,id),draft=this.state.directorNameDrafts?.[id];
      if(!draft||draft.token!==tokens?.[id]?.token||draft.revision!==tokens?.[id]?.revision)throw Error('Предложение изменилось. Открой актуальный предпросмотр.');
      if(!draft.reviewed||!draft.selected||!draft.name.trim())throw Error('Сначала проверь и выбери все предложения.');
      if(draft.baseVersion!==I.version(d))throw Error(`Имя «${d.name}» изменилось после начала правки. Обнови исходное имя и проверь предложение.`);
      return {id,d,draft};
    });
    const log={id:randomUUID(),at:new Date().toISOString(),changes:[]};
    transaction(this,picked.map(x=>x.d),()=>{
      this.state.directorNameDrafts={...(this.state.directorNameDrafts||{})};
      for(const {id,d,draft} of picked){
        const before=I.snapshot(d);
        d.tmdbName=d.tmdbName||d.name;d.aliases=unique([...(d.aliases||[]),d.name,d.tmdbName,draft.name]);
        d.userName=draft.name;d.name=draft.name;d.sortSurname=draft.surname||null;d.nameReviewed=true;
        log.changes.push({id,before,afterVersion:I.version(d)});delete this.state.directorNameDrafts[id];
      }
      this.state.directorNameHistory=[...(this.state.directorNameHistory||[]),log];
    });return this.state;
  },
  undoDirectorNames(batchId){
    const history=this.state.directorNameHistory||[],batch=history.find(b=>b.id===batchId);if(!batch)throw Error('Изменение имён не найдено.');
    const records=batch.changes.map(change=>{const d=director(this,change.id);if(I.version(d)!==change.afterVersion)throw Error(`Имя «${d.name}» уже изменено позднее. Отмена не должна затереть новую правку.`);return d;});
    transaction(this,records,()=>{
      batch.changes.forEach((change,i)=>{const d=records[i],aliases=unique([...(d.aliases||[]),d.name,change.before.name,change.before.tmdbName]);I.fields.forEach(k=>delete d[k]);Object.assign(d,change.before);d.aliases=aliases;});
      this.state.directorNameHistory=history.filter(b=>b.id!==batchId);
    });return this.state;
  },
  async suggestDirectorNames(id){
    const d=director(this,id);if(!this.tmdb)throw Error('Для загрузки вариантов нужен доступ к TMDB.');
    const person=await this.tmdb.get(`/person/${encodeURIComponent(id)}`);
    if(director(this,id)!==d)throw Error('Библиотека изменилась во время запроса. Повтори загрузку.');
    if(String(person.id)!==String(d.id))throw Error('TMDB вернул сведения о другом человеке.');
    const names=unique([person.name,...(Array.isArray(person.also_known_as)?person.also_known_as:[])]);
    const aliases=d.aliases;d.aliases=unique([...(d.aliases||[]),d.name,d.tmdbName,...names]);
    try{this.save();}catch(e){if(aliases===undefined)delete d.aliases;else d.aliases=aliases;throw e;}
    return {state:this.state,names,russian:names.filter(I.hasCyrillic)};
  },
};
module.exports={directorNameMethods};
