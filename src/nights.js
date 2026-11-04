'use strict';
const P=require('./planner');
const clone=x=>JSON.parse(JSON.stringify(x));
function getNight(s,id){const n=(s.state.nights||[]).find(n=>n.id===id);if(!n)throw Error('Ночь не найдена.');return n;}
function getSlot(s,nid,index){const n=getNight(s,nid),slot=n.slots[index];if(!slot)throw Error('Место не найдено.');return {n,slot};}
const nightMethods={
  saveNightDraft(config){P.validate(config);this.state.nightDraft=clone(config);this.save();return this.state;},
  generateNight(config,options={}){const result=P.generate(this.state,config,options);if(result.ok){this.state.nightDraft=result.config;this.save();}return {...result,state:this.state};},
  saveNightTemplate(name,config){P.validate(config);name=String(name||'').trim().slice(0,80);if(!name)throw Error('Введи название шаблона.');const template=clone(config);delete template.editingNightId;template.slots.forEach(s=>{s.film=null;s.locked=false;});this.state.nightTemplates=this.state.nightTemplates||[];this.state.nightTemplates.push({id:require('crypto').randomUUID(),name,config:template});this.save();return this.state;},
  removeNightTemplate(id){this.state.nightTemplates=(this.state.nightTemplates||[]).filter(t=>t.id!==id);this.save();return this.state;},
  setNightTags(key,tags){const f=this.mustFilm(key);if(!['unknown','light','medium','heavy'].includes(tags.weight)||!['unknown','easy','medium','focused'].includes(tags.attention)||!Array.isArray(tags.styles)||tags.styles.some(s=>!['noir','neonoir'].includes(s))||tags.runtime!==null&&(!Number.isInteger(tags.runtime)||tags.runtime<1||tags.runtime>10080))throw Error('Проверь характеристики фильма.');f.nightTags=clone(tags);this.save();return this.state;},
  approveNight(config,date){const checked=P.check(this.state,config);if(checked.errors.length)throw Error(checked.errors.join(' '));if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('Выбери дату начала ночи.');
    const night={id:require('crypto').randomUUID(),date,createdAt:new Date().toISOString(),config:clone(config),total:checked.total,unknownRuntime:checked.unknownRuntime,tasks:{},slots:checked.rows.map((r,i)=>({key:r.key,title:P.title(this.mustFilm(r.key)),year:this.mustFilm(r.key).year,runtime:r.runtime,reasons:r.reasons,index:i,result:null,rating:null}))};
    this.state.nights=this.state.nights||[];this.state.nights.push(night);this.state.activeNight=night.id;this.state.nightDraft=clone(config);delete this.state.nightDraft.editingNightId;this.save();return {state:this.state,nightId:night.id};},
  reviseNight(nid,config){const n=getNight(this,nid);if(n.slots.some(s=>s.result))throw Error('Ночь уже разбиралась. Создай новый план, чтобы сохранить историю.');const checked=P.check(this.state,config);if(checked.errors.length)throw Error(checked.errors.join(' '));
    n.revisions=n.revisions||[];n.revisions.push({at:new Date().toISOString(),config:n.config,slots:n.slots,total:n.total});
    const old=n.slots;n.slots=checked.rows.map((r,i)=>({key:r.key,title:P.title(this.mustFilm(r.key)),year:this.mustFilm(r.key).year,runtime:r.runtime,reasons:r.reasons,index:i,result:null,rating:null}));
    n.tasks=Object.fromEntries(Object.entries(n.tasks).filter(([key])=>{const i=Number(key.split(':')[0]);return old[i]?.key===n.slots[i]?.key;}));n.config=clone(config);n.total=checked.total;n.unknownRuntime=checked.unknownRuntime;this.state.nightDraft=clone(config);delete this.state.nightDraft.editingNightId;this.save();return {state:this.state,nightId:nid};},
  setNightTask(nid,key,done){const n=getNight(this,nid);if(typeof key!=='string'||key.length>250||typeof done!=='boolean')throw Error('Некорректная задача.');n.tasks[key]=done;this.save();return this.state;},
  setNightResult(nid,index,result){if(![null,'watched','dropped','skipped'].includes(result))throw Error('Некорректный результат.');const {n,slot}=getSlot(this,nid,index);if(slot.result===result)return this.state;
    if((this.state.nights||[]).some(other=>this.state.nights.indexOf(other)>this.state.nights.indexOf(n)&&other.slots.some(x=>x.key===slot.key&&['watched','dropped'].includes(x.result))))throw Error('У фильма есть более поздний просмотр. Разбери его перед изменением старой отметки.');
    const f=this.mustFilm(slot.key);
    const changesFilm=!!slot.before||['watched','dropped'].includes(result);
    if(slot.before){f.watched=(f.watched||[]).filter(w=>!(w.nightId===nid&&w.slot===index));if(f.status===slot.result){f.status=slot.before.status;f.pending=slot.before.pending;}
      if(slot.ratingEdited&&f.rating===slot.rating)f.rating=slot.before.rating;
      for(const saved of slot.before.near){if(!saved.entry.ids.some(k=>['watched','dropped'].includes(this.state.films[k]?.status))&&!this.state.near.some(e=>e.key===saved.entry.key)){this.state.near.splice(Math.min(saved.index,this.state.near.length),0,saved.entry);this.state.nearRemoved=(this.state.nearRemoved||[]).filter(k=>k!==saved.entry.key);}}
      delete slot.before;delete slot.ratingEdited;slot.rating=null;
    }
    slot.result=result;
    if(['watched','dropped'].includes(result)){
      slot.before={status:f.status,pending:!!f.pending,rating:f.rating??null,near:this.state.near.flatMap((e,i)=>e.ids.includes(f.key)?[{entry:clone(e),index:i}]:[])};
      f.status=result;f.pending=slot.before.pending;f.watched=f.watched||[];f.watched.push({date:n.date,result,nightId:nid,slot:index});this.dropNear(f.key);
    }
    if(changesFilm){this.afterQueueChange(f.dir);this.refreshTasks();}this.save();return this.state;
  },
  rateNight(nid,index,rating){const {slot}=getSlot(this,nid,index);if(!['watched','dropped'].includes(slot.result))throw Error('Сначала отметь просмотр или «Бросил».');if(rating!==null&&(!Number.isInteger(rating)||rating<1||rating>10))throw Error('Оценка от 1 до 10.');slot.rating=rating;slot.ratingEdited=true;this.mustFilm(slot.key).rating=rating;this.save();return this.state;},
};
module.exports={nightMethods};
