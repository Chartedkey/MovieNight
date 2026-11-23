'use strict';
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const meta=new Set('key tmdbId tmdbTitle originalTitle year runtime countries countryCodes genres genreIds altTitles overview poster popularity voteAverage voteCount dir directorIds kpLink watched titleSource pending moveTask queueChosen nightTags'.split(' '));
const fields=[['status','Статус',f=>f.status||'candidate'],['rating','Оценка',f=>f.rating??null],['userTitle','Личное название',f=>f.userTitle||null],['kpLink','Личная ссылка на Кинопоиск',f=>f.kpLink||null],['wish','Хочу посмотреть',f=>!!f.wish],['rewatch','Пересмотреть',f=>!!f.rewatch],['keepOnDisk','Оставить на диске',f=>!!f.keepOnDisk],['dupOk','Несколько копий разрешены',f=>!!f.dupOk]];
const tags=[['weight','Эмоциональная нагрузка','unknown'],['attention','Требуемое внимание','unknown'],['styles','Нуар / неонуар',[]],['runtime','Ручная длительность',null]];
function values(state,source,target){
  const out=fields.map(([field,label,read])=>({field,label,path:[field],source:read(source),target:read(target)}));
  for(const [key,label,fallback] of tags)out.push({field:`nightTags.${key}`,label,path:['nightTags',key],source:source.nightTags?.[key]??clone(fallback),target:target.nightTags?.[key]??clone(fallback)});
  const known=new Set([...meta,...fields.map(([key])=>key)]);
  for(const key of new Set([...Object.keys(source),...Object.keys(target)]))if(!known.has(key))out.push({field:`extra:${key}`,label:`Дополнительная отметка «${key}»`,path:[key],source:source[key]??null,target:target[key]??null});
  for(const key of new Set([...Object.keys(source.nightTags||{}),...Object.keys(target.nightTags||{})]))if(!tags.some(([k])=>k===key))out.push({field:`tag:${key}`,label:`Дополнительная характеристика «${key}»`,path:['nightTags',key],source:source.nightTags?.[key]??null,target:target.nightTags?.[key]??null});
  out.push({field:'near',label:'В ближайших',path:null,source:(state.near||[]).some(e=>e.ids.includes(source.key)),target:(state.near||[]).some(e=>e.ids.includes(target.key))});
  return out;
}
function setValue(object,path,value){
  if(path.length===2){if(!object[path[0]])object[path[0]]={};object=object[path[0]];}
  Object.defineProperty(object,path[path.length-1],{value:clone(value),enumerable:true,writable:true,configurable:true});
}
function selected(plan,options){
  if(options.mergeConfirmed!==true)throw Error('Подтверди объединение двух записей.');
  const choices=options.mergeChoices||{},result={},selectedFields={};
  let near=false;
  for(const item of plan.mergeFields){
    const conflict=!equal(item.source,item.target);
    const choice=conflict?choices[item.field]:'target';
    if(conflict&&!['source','target'].includes(choice))throw Error(`Выбери, что сохранить: ${item.label}.`);
    selectedFields[item.field]=choice;
    if(item.path)setValue(result,item.path,item[choice]);else near=item[choice];
  }
  if(result.status==='queue'&&plan.queue.growsIfQueue&&plan.queue.count>=3&&options.allowExtraQueue!==true)throw Error('Подтверди сохранение фильма сверх трёх в очереди правильного режиссёра или выбери другой статус.');
  return {personal:result,near,selectedFields};
}
function histories(source,target){
  const result=[];
  for(const entry of [...(target.watched||[]),...(source.watched||[])]){
    const stable=entry.id!=null||entry.nightId!=null&&entry.slot!=null;
    if(!stable||!result.some(other=>equal(other,entry)))result.push(clone(entry));
  }
  return result.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
}
function reconcileNear(state,key,keep){
  let found=false;const removed=[];
  state.near=(state.near||[]).map(e=>{
    const ids=e.ids.filter(id=>id!==key||keep&&!found);
    if(ids.includes(key))found=true;
    if(!ids.length){removed.push(e.key);return null;}return {...e,ids};
  }).filter(Boolean);
  state.nearRemoved=[...new Set([...(state.nearRemoved||[]),...removed])];state.nearTouched=true;
  // Keep import-backed alternative rows consistent with the de-duplicated near list.
  const id=state.films[key].tmdbId,job=state.job;
  for(const entry of job?.nearEntries||[]){
    if(state.near.some(e=>e.key===entry.key&&e.ids.includes(key)))continue;
    entry.refs=(entry.refs||[]).filter(ref=>{
      const movie=ref.tmdbId??(ref.itemId!=null?job.items?.[ref.itemId]?.tmdbId:ref.nearItem?(job.nearItems||[]).find(i=>i.id===ref.nearItem)?.tmdbId:null);
      return movie!==id;
    });
  }

}
function freezeHistory(state,sourceKey,targetKey,keepFiles){
  for(const night of state.nights||[]){
    if(night.slots.some(s=>s.key===sourceKey)&&night.slots.some(s=>s.key===targetKey))night.mergeReviewRequired=true;
    night.slots.forEach((slot,index)=>{
      if(![sourceKey,targetKey].includes(slot.key))return;
      if(slot.result||slot.before)slot.mergedFilm=true;
      else if(night.mergeReviewRequired)slot.mergePlanConflict=true;
      if(slot.key===sourceKey&&!keepFiles)for(const key of Object.keys(night.tasks||{}))if(key.startsWith(`${index}:`))delete night.tasks[key];
    });
  }
}
module.exports={values,equal,selected,histories,reconcileNear,freezeHistory};
