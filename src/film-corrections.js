'use strict';
const {randomUUID,createHash}=require('crypto');
const {searchFilm}=require('./matcher');
const Merge=require('./film-merge');
const Archive=require('./archive');
const clone=x=>JSON.parse(JSON.stringify(x));
const signature=state=>createHash('sha256').update(JSON.stringify(state)).digest('hex');
function idle(s){
  if(s.running||s.scanning||s.transferBusy)throw Error('Дождись завершения импорта, проверки дисков или переноса.');
  if((s.state.nightTransfers||[]).some(j=>!['completed','dismissed'].includes(j.status)))throw Error('Сначала заверши восстановление и закрой незавершённые переносы.');
}
function mapConfig(c,from,to){if(!c)return;for(const slot of c.slots||[])if(slot.film===from)slot.film=to;if(c.rejectedFilms)c.rejectedFilms=[...new Set(c.rejectedFilms.map(k=>k===from?to:k))];}
function mapNear(entries,from,to){for(const e of entries||[])if(e.ids)e.ids=[...new Set(e.ids.map(k=>k===from?to:k))];}
function mapSlots(slots,from,to){for(const slot of slots||[]){if(slot.key===from)slot.key=to;for(const saved of slot.before?.near||[])mapNear([saved.entry],from,to);}}
const correctionMethods={
  async searchFilmCorrection(key,query){
    this.mustFilm(key);const q=String(query||'').trim();if(!q)throw Error('Введи название фильма, год или ссылку TMDB.');
    if(!this.tmdb)throw Error('Подключи TMDB для поиска правильного фильма.');
    const link=q.match(/^https:\/\/(?:www\.)?themoviedb\.org\/movie\/(\d+)(?:[-/?#]|$)/i);
    let results;
    if(link){const d=await this.detail(Number(link[1]));results=[{id:d.id,title:d.title||d.displayTitle,originalTitle:d.originalTitle,year:d.year}];}
    else{const {parseName}=require('./scanner'),parsed=parseName(q,false);results=await searchFilm(this.tmdb,parsed.title,parsed.year);}
    const out=[];
    for(const item of results){const d=await this.detail(item.id);out.push({id:d.id,title:d.title||d.displayTitle||d.originalTitle,originalTitle:d.originalTitle,year:d.year,poster:d.poster,directors:d.directors,runtime:d.runtime,overview:d.overview,inLibrary:!!this.state.films[`m${d.id}`]&&`m${d.id}`!==key});}
    return out;
  },
  async previewFilmCorrection(key,tmdbId){
    idle(this);const old=clone(this.mustFilm(key));if(!Number.isSafeInteger(tmdbId)||tmdbId<=0)throw Error('Некорректный фильм TMDB.');
    const before=signature(this.state),d=clone(await this.detail(tmdbId));idle(this);
    if(signature(this.state)!==before)throw Error('База изменилась. Открой предпросмотр заново.');
    if(!d.directors.length)throw Error('В TMDB не указан режиссёр. Выбери другую запись.');
    const newKey=`m${d.id}`;
    const existing=newKey!==key&&this.state.films[newKey]?clone(this.state.films[newKey]):null;
    const mergeFields=existing?Merge.values(this.state,old,existing):[];
    const queue={count:Object.values(this.state.films).filter(f=>f.dir===d.directors[0].id&&f.status==='queue'&&![key,newKey].includes(f.key)).length,growsIfQueue:!!existing&&existing.status!=='queue'&&!(old.status==='queue'&&old.dir===d.directors[0].id)};
    const files=Object.values(this.state.files||{}).filter(e=>e.filmKey===key).map(e=>({id:e.id,path:e.path}));
    const archive=Object.values(this.state.archiveEntries||{}).filter(e=>e.confirmedKey===key||e.candidates?.includes(key)).map(e=>({id:e.id,path:e.path}));
    const targetFiles=existing?Object.values(this.state.files||{}).filter(e=>e.filmKey===newKey&&e.state==='linked'&&!Archive.isArchive(this.state,e)).map(e=>({id:e.id,path:e.path})):[];
    const targetArchive=existing?Archive.hits(this.state,newKey).map(e=>({id:e.id,path:e.path,confirmed:e.confirmedKey===newKey})):[];
    const token=randomUUID(),plan={key,newKey,old,d,before,files,archive,existing,mergeFields,queue,expires:Date.now()+15*60*1000};
    this.filmCorrectionPlans=this.filmCorrectionPlans||new Map();
    for(const [id,p] of this.filmCorrectionPlans)if(p.expires<Date.now())this.filmCorrectionPlans.delete(id);
    if(this.filmCorrectionPlans.size>=20)this.filmCorrectionPlans.delete(this.filmCorrectionPlans.keys().next().value);
    this.filmCorrectionPlans.set(token,plan);
    return {token,old,existing,queue,conflicts:mergeFields.filter(f=>!Merge.equal(f.source,f.target)).map(({field,label,source,target})=>({field,label,source,target})),targetFiles,targetArchive,target:{key:newKey,tmdbId:d.id,tmdbTitle:d.title||d.displayTitle||d.originalTitle,originalTitle:d.originalTitle,year:d.year,poster:d.poster,directors:d.directors,runtime:d.runtime,overview:d.overview},files,archive};
  },
  rejectFilmCorrection(token){
    idle(this);const plan=this.filmCorrectionPlans?.get(token);
    if(!plan||plan.expires<Date.now())throw Error('Предпросмотр устарел. Открой его заново.');
    if(!plan.existing)throw Error('Нет существующей карточки для проверки.');
    if(signature(this.state)!==plan.before)throw Error('База изменилась. Открой предпросмотр заново.');
    const previous=this.state;this.state=clone(previous);
    this.state.films[plan.key].correctionReview=true;
    try{this.save();}catch(e){this.state=previous;throw e;}
    this.filmCorrectionPlans.delete(token);
    return this.state;
  },
  applyFilmCorrection(token,options={}){
    idle(this);const plan=this.filmCorrectionPlans?.get(token);
    if(!plan||plan.expires<Date.now())throw Error('Предпросмотр устарел. Открой его заново.');
    if(options.confirmed!==true||typeof options.keepTitle!=='boolean'||typeof options.keepFiles!=='boolean')throw Error('Подтверди замену фильма и настройки сохранения.');
    if(signature(this.state)!==plan.before)throw Error('База изменилась. Открой предпросмотр заново.');
    if(options.useExisting===true){
      if(!plan.existing)throw Error('Существующая карточка не найдена.');
      options={...options,keepFiles:false,mergeChoices:Object.fromEntries(plan.mergeFields.map(f=>[f.field,'target']))};
    }
    const resolution=plan.existing?Merge.selected(plan,options):null;
    const previous=this.state,next=clone(previous),{key,newKey,d,old}=plan;
    this.state=next;
    try{
      delete next.films[key];
      if(plan.existing)delete next.films[newKey];
      const corrected=this.ensureFilm(d,{status:old.status});
      const metadata=clone(corrected);
      Object.assign(corrected,old,metadata,{key:newKey,tmdbId:d.id,status:old.status,rating:old.rating??null,watched:clone(old.watched||[])});
      // Keep every personal field; replace only TMDB data and explicitly selected title.
      for(const field of Object.keys(old))if(!Object.hasOwn(metadata,field))corrected[field]=clone(old[field]);
      for(const field of ['rewatch','pending','wish','queueChosen','nightTags','moveTask','keepOnDisk','dupOk'])if(Object.hasOwn(old,field))corrected[field]=clone(old[field]);
      corrected.userTitle=options.keepTitle?old.userTitle||null:null;corrected.titleSource=options.keepTitle?old.titleSource||null:null;
      if(!options.keepFiles&&Object.hasOwn(old,'moveTask'))corrected.moveTask=false;
      corrected.kpLink=newKey===key?old.kpLink||null:null;
      if(plan.existing){
        const target=plan.existing;
        Object.assign(corrected,resolution.personal);
        corrected.watched=Merge.histories(old,target);
        const from=resolution.selectedFields.userTitle==='source'?old:target;
        corrected.titleSource=corrected.userTitle?from.titleSource||null:null;
        corrected.pending=['watched','dropped'].includes(corrected.status)&&!!(old.pending||target.pending);
        corrected.queueChosen=corrected.status==='queue';
        Merge.freezeHistory(next,key,newKey,options.keepFiles);
      }

      delete corrected.correctionReview;
      mapNear(next.near,key,newKey);
      mapConfig(next.nightDraft,key,newKey);
      for(const template of next.nightTemplates||[])mapConfig(template.config,key,newKey);
      for(const night of next.nights||[]){mapSlots(night.slots,key,newKey);mapConfig(night.config,key,newKey);for(const revision of night.revisions||[]){mapSlots(revision.slots,key,newKey);mapConfig(revision.config,key,newKey);}}
      const updateEntry=e=>{
        if(e.filmKey===key){if(options.keepFiles){e.filmKey=newKey;e.matchMethod='manual';}else{delete e.filmKey;delete e.matchMethod;e.state=e.state==='ignored'?'ignored':'orphan';e.forceReview=true;}}
        if(e.candidates)e.candidates=[...new Set(e.candidates.map(k=>k===key?newKey:k))];
        for(const part of e.dvdPartHistory||[])updateEntry(part);
      };
      for(const e of Object.values(next.files||{}))updateEntry(e);
      for(const [name,linked] of Object.entries(next.nameLinks||{}))if(linked===key)delete next.nameLinks[name];
      for(const e of Object.values(next.archiveEntries||{})){
        if(e.confirmedKey===key){e.confirmedKey=null;e.manual=false;}
        if(e.candidates)e.candidates=e.candidates.filter(k=>k!==key);
        if(e.rejected)e.rejected=e.rejected.filter(k=>k!==key);
      }
      if(resolution){
        const linked=Object.values(next.files||{}).some(e=>e.filmKey===newKey&&e.state==='linked');
        corrected.moveTask=['watched','dropped'].includes(corrected.status)&&!corrected.keepOnDisk&&linked;
      }
      // Prevent a resumed import or rebuildNear from resurrecting the incorrect identity.
      for(const item of [...(next.job?.items||[]),...(next.job?.nearItems||[])])if(item.tmdbId===old.tmdbId){item.tmdbId=d.id;item.dirIds=d.directors.map(x=>x.id);if(item.groupDir!=null)item.groupDir=corrected.dir;}
      for(const entry of next.job?.nearEntries||[])for(const ref of entry.refs||[])if(ref.tmdbId===old.tmdbId)ref.tmdbId=d.id;
      if(resolution)Merge.reconcileNear(next,newKey,resolution.near);
      next.filmCorrections=next.filmCorrections||[];next.filmCorrections.push({id:randomUUID(),at:new Date().toISOString(),before:old,existing:plan.existing,mergeChoices:resolution?.selectedFields||null,beforeRelations:resolution?{near:clone(previous.near),nightDraft:clone(previous.nightDraft||null),nights:clone(previous.nights||[])}:null,after:clone(corrected),keepFiles:options.keepFiles,files:plan.files,archive:plan.archive});
      this.save();
    }catch(e){this.state=previous;throw e;}
    this.filmCorrectionPlans.delete(token);
    for(const [id,p] of this.transferPlans||[])if(p.plan.entry.filmKey===key)this.transferPlans.delete(id);
    for(const [id,e] of this.graveyard||[])if(e.filmKey===key)this.graveyard.delete(id);
    return {state:this.state,filmKey:newKey,merged:!!plan.existing};
  },
};
module.exports={correctionMethods};
