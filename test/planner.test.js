'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const P=require('../src/planner'),{Service}=require('../src/service');
function state(){return {films:Object.fromEntries(Array.from({length:8},(_,i)=>[`m${i+1}`,{key:`m${i+1}`,tmdbId:i+1,userTitle:`Фильм ${i+1}`,year:2000+i,dir:i+1,directorIds:[i+1],status:i<4?'queue':'disk',runtime:90,countries:i%2?['Франция']:['Япония'],genres:['Криминал','Триллер'],nightTags:{weight:i%2?'heavy':'light',attention:'easy',styles:['noir']},watched:[],rating:null,pending:false}])),directors:Object.fromEntries(Array.from({length:8},(_,i)=>[i+1,{id:i+1,name:`Режиссёр ${i+1}`,fav:i<3}])),near:[{key:'n1',ids:['m1']},{key:'n2',ids:['m2']},{key:'n3',ids:['m3']}],files:{a:{id:'a',path:'/films/a.mkv',filmKey:'m5',state:'linked',duration:88,role:'today',size:10}},folders:[],settings:{},nearRemoved:[]};}
function svc(){const s=new Service({dir:fs.mkdtempSync(path.join(os.tmpdir(),'mn-night-'))});s.state={...s.state,...state()};return s;}
const config=(n=4)=>({...P.defaults(),count:n,nearCount:Math.min(2,n),slots:Array.from({length:n},P.slot)});
test('подбор соблюдает время, квоты, закрепление, регион и жанр',()=>{const s=state(),c=config();c.source='mix';c.nearCount=2;c.limit=390;c.slots[0].film='m1';c.slots[0].locked=true;c.slots[0].region='asia';c.slots[1].country='FR';c.slots[1].genre='crime-thriller';const result=P.generate(s,c);assert.equal(result.ok,true);assert.equal(result.config.slots[0].film,'m1');assert.equal(result.rows.filter(r=>r.near).length,2);assert.ok(result.total<=390);assert.equal(new Set(result.rows.map(r=>r.key)).size,4);});
test('скачанный запас предпочтительнее нескaчанной очереди; локальная длительность учитывается',()=>{const s=state(),c=config(1);c.source='all';const r=P.generate(s,c);assert.equal(r.rows[0].key,'m5');assert.equal(r.rows[0].runtime,88);s.folders=[{path:'/films',status:'offline'}];c.availability='only';assert.equal(P.generate(s,c).ok,false);});
test('неизвестные характеристики и длительность не удовлетворяют строгим условиям',()=>{const s=state(),c=config(1);for(const f of Object.values(s.films)){f.runtime=null;delete f.nightTags;}s.files={};assert.equal(P.generate(s,c).ok,false);c.limit=0;assert.equal(P.generate(s,c).ok,true);c.slots[0].weight='light';assert.equal(P.generate(s,c).ok,false);});
test('альтернативы или и совместный режиссёр не занимают два места',()=>{const s=state(),c=config(2);c.source='near';s.near=[{key:'or',ids:['m1','m2']}];assert.equal(P.generate(s,c).ok,false);s.near=[{key:'a',ids:['m1']},{key:'b',ids:['m2']}];s.films.m2.directorIds=[1,2];assert.equal(P.generate(s,c).ok,false);c.repeat=true;assert.equal(P.generate(s,c).ok,true);});
test('замена сохраняет остальные фильмы и не нарушает закрепление',()=>{const s=state(),c=P.generate(s,config()).config;const old=c.slots.map(s=>s.film);const r=P.generate(s,c,{replace:1,seed:7});assert.equal(r.ok,true);assert.notEqual(r.config.slots[1].film,old[1]);old.forEach((k,i)=>{if(i!==1)assert.equal(r.config.slots[i].film,k);});c.slots[1].locked=true;assert.throws(()=>P.generate(s,c,{replace:1}),/открепи/);});
test('пересмотр и фильмография включаются явно; любимые только по ручной метке',()=>{const s=state(),c=config(1);s.films.m1.status='watched';s.films.m1.rewatch=true;c.slots[0].director='1';assert.equal(P.generate(s,c).ok,false);c.rewatch=true;assert.equal(P.generate(s,c).ok,true);s.films.m1.status='candidate';c.rewatch=false;assert.equal(P.generate(s,c).ok,false);c.allowFilmography=true;assert.equal(P.generate(s,c).ok,true);c.mode='favorites';s.directors[1].fav=false;s.films.m1.rating=10;assert.equal(P.generate(s,c).ok,false);});
test('Польша и скандинавские страны входят в европейское кино по старым и новым данным',()=>{for(const name of ['Польша','Норвегия','Швеция','Финляндия','Исландия','Denmark']){const s=state(),c=config(1);c.slots[0].director='1';c.slots[0].region='europe';s.films.m1.countries=[name];assert.equal(P.generate(s,c).ok,true,name);}});
test('утверждение и шаблон не меняют библиотеку; черновик и история переживают перезапуск',()=>{const s=svc(),c=P.generate(s.state,config()).config,before=JSON.stringify(s.state.films);s.saveNightDraft(c);s.saveNightTemplate('Шаблон',c);s.approveNight(c,'2026-11-04');assert.equal(JSON.stringify(s.state.films),before);const restored=new Service({dir:s.dir});assert.equal(restored.state.nights.length,1);assert.equal(restored.state.nightDraft.slots.length,4);assert.equal(restored.state.nightTemplates[0].config.slots.every(s=>!s.film&&!s.locked),true);});
test('не посмотрел сохраняет очередь и ближайшие, просмотр можно отменить без дублей истории',()=>{const s=svc(),c=config(1);c.slots[0].film='m1';const {nightId}=s.approveNight(c,'2026-11-04');const before=JSON.stringify(s.state.films.m1),near=JSON.stringify(s.state.near);s.setNightResult(nightId,0,'skipped');assert.equal(JSON.stringify(s.state.films.m1),before);assert.equal(JSON.stringify(s.state.near),near);assert.throws(()=>s.rateNight(nightId,0,8),/Сначала/);s.setNightResult(nightId,0,'watched');s.setNightResult(nightId,0,'watched');assert.equal(s.state.films.m1.watched.length,1);s.rateNight(nightId,0,8);s.setNightResult(nightId,0,null);assert.equal(s.state.films.m1.watched.length,0);assert.equal(s.state.films.m1.status,'queue');assert.equal(s.state.films.m1.rating,null);assert.equal(JSON.stringify(s.state.near),near);});
test('пропуск пересмотра не закрывает прежнюю задачу переноса',()=>{const s=svc(),c=config(1);s.state.films.m5.status='watched';s.state.films.m5.rewatch=true;c.rewatch=true;c.slots[0].film='m5';s.refreshTasks();const {nightId}=s.approveNight(c,'2026-11-04');s.setNightResult(nightId,0,'skipped');assert.equal(s.state.films.m5.moveTask,true);});
test('изменение старой ночи не отменяет более поздний просмотр; неверная дата отклоняется',()=>{const s=svc(),c=config(1);c.slots[0].film='m1';assert.throws(()=>s.approveNight(c,'2026-02-31'),/дату/);const first=s.approveNight(c,'2026-11-04').nightId;s.setNightResult(first,0,'watched');c.rewatch=true;s.state.films.m1.rewatch=true;const second=s.approveNight(c,'2026-11-05').nightId;s.setNightResult(second,0,'watched');assert.throws(()=>s.setNightResult(first,0,null),/поздний/);});
test('выбор имени keep/custom сохраняется; расширение отдельно и дополнительного года нет',async()=>{const s=svc(),r=s.dir,file=path.join(r,'Старое.mkv');fs.writeFileSync(file,'video');s.state.files={x:{id:'x',path:file,name:'Старое.mkv',title:'Старое',filmKey:'m1',state:'linked',kind:'file'}};s.setRenamePreference('x','keep');assert.equal(s.renamePlan().length,0);assert.equal(new Service({dir:r}).state.files.x.renamePreference,'keep');s.setRenamePreference('x','custom','Личное имя (2020).mkv');const p=s.renamePlan()[0];assert.equal(p.to,'Личное имя (2020).mkv');assert.equal(p.requiresConfirmation,true);await s.applyRename(['x'],['x']);assert.ok(fs.existsSync(path.join(r,p.to)));assert.equal(s.renamePlan().length,0);assert.throws(()=>s.setRenamePreference(p.dir+'/missing','custom','x'),/не найден/);const id=Object.keys(s.state.files)[0];for(const bad of ['../escape','CON','..','bad:name'])assert.throws(()=>s.setRenamePreference(id,'custom',bad));});

test('соседняя папка с похожим именем не становится недоступной',()=>{const s=state(),c=config(1);s.folders=[{path:'/films2',status:'offline'}];c.availability='only';assert.equal(P.generate(s,c).ok,true);});
test('отмена результата после снятия оценки восстанавливает прежнюю оценку',()=>{const s=svc(),c=config(1);s.state.films.m1.rating=9;c.slots[0].film='m1';const n=s.approveNight(c,'2026-11-04').nightId;s.setNightResult(n,0,'watched');s.rateNight(n,0,null);s.setNightResult(n,0,null);assert.equal(s.state.films.m1.rating,9);});
test('не возвращается строка или, если другой её фильм уже просмотрен',()=>{const s=svc(),c=config(1);s.state.near=[{key:'or',ids:['m1','m2']}];c.slots[0].film='m1';const n=s.approveNight(c,'2026-11-04').nightId;s.setNightResult(n,0,'watched');s.state.films.m2.status='watched';s.setNightResult(n,0,null);assert.equal(s.state.near.length,0);});
test('отказ от переименования переживает изменение размера файла и повторный обход',async()=>{const s=svc(),r=s.dir;const file=path.join(r,'Фильм 1 (2001).mkv');const {MIN_FILM_BYTES}=require('../src/scanner');const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,MIN_FILM_BYTES+1);fs.closeSync(fd);s.state.files={};s.addFolder(r);await s.scanAll();const id=Object.keys(s.state.files)[0];s.chooseEntryFilm(id,'m1');s.setRenamePreference(id,'keep');fs.truncateSync(file,MIN_FILM_BYTES+10);await s.scanAll();assert.equal(s.state.files[id].renamePreference,'keep');assert.equal(s.renamePlan().length,0);});
test('ограниченный поиск сообщает об отсутствии результата без ослабления фильтров',()=>{const s=state(),c=config();const r=P.generate(s,c,{maxNodes:0});assert.equal(r.ok,false);assert.match(r.message,/отведённое время/);assert.deepEqual(r.config,c);});
test('страны старой библиотеки распознаются и вне первых регионов',()=>{assert.equal(P.codeOf('Кот-д’Ивуар'),'CI');assert.equal(P.codeOf('Аргентина'),'AR');assert.equal(P.codeOf('France'),'FR');assert.equal(P.codeOf('Новая Зеландия'),'NZ');});

test('изменение утверждённого плана сохраняет идентичность, но не допускается после разбора',()=>{const s=svc(),c=P.generate(s.state,config()).config;const id=s.approveNight(c,'2026-11-04').nightId;const changed=P.generate(s.state,c,{replace:0}).config;s.reviseNight(id,changed);assert.equal(s.state.nights.length,1);assert.equal(s.state.nights[0].revisions.length,1);assert.equal(s.state.nights[0].slots[0].key,changed.slots[0].film);s.setNightResult(id,0,'skipped');assert.throws(()=>s.reviseNight(id,c),/разбиралась/);});

test('сброс всего подбора сохраняет библиотеку, шаблоны, историю и утверждённую ночь',()=>{
  const s=svc(),c=P.generate(s.state,config()).config;
  const nid=s.approveNight(c,'2026-11-04').nightId;s.saveNightTemplate('Мой шаблон',c);s.setNightResult(nid,0,'skipped');
  c.limit=900;c.slots[0].locked=true;c.editingNightId=nid;s.saveNightDraft(c);
  const before=JSON.parse(JSON.stringify(s.state));s.resetNightDraft();
  assert.deepEqual(s.state.nightDraft,P.defaults());
  for(const key of Object.keys(before).filter(k=>k!=='nightDraft'))assert.deepEqual(s.state[key],before[key],key);
  const restored=new Service({dir:s.dir});assert.deepEqual(restored.state.nightDraft,P.defaults());assert.equal(restored.state.nights[0].slots[0].result,'skipped');assert.equal(restored.state.activeNight,nid);
});

test('внимание сегодня — верхний предел: среднее допускает easy/medium, неизвестное не считается лёгким',()=>{
  const s=state(),c=config(1);Object.values(s.films).forEach(f=>f.status='nointerest');s.films.m1.status='queue';
  c.slots[0].attention='medium';for(const level of ['easy','medium']){s.films.m1.nightTags.attention=level;assert.equal(P.generate(s,c).ok,true,level);}
  for(const level of ['focused','unknown',undefined]){s.films.m1.nightTags.attention=level;assert.equal(P.generate(s,c).ok,false,String(level));}
  c.slots[0].attention='focused';for(const level of ['easy','medium','focused']){s.films.m1.nightTags.attention=level;assert.equal(P.generate(s,c).ok,true,level);}
  c.slots[0].attention='easy';s.films.m1.nightTags.attention='medium';assert.equal(P.generate(s,c).ok,false);
});

test('сценарий скриншота: отказ на первом/азиатском месте объясняется отсутствием ручной отметки',()=>{
  const s=state(),c=config();for(const f of Object.values(s.films))delete f.nightTags;
  c.slots[0].attention='medium';c.slots[1].attention='medium';c.slots[1].region='asia';
  const before=JSON.stringify({s,c});let r=P.generate(s,c);assert.equal(r.ok,false);assert.equal(r.issue.index,0);assert.match(r.message,/Не задана ваша отметка внимания/);assert.equal(r.issue.diagnosis.excluded.attentionUnknown,8);assert.equal(JSON.stringify({s,c}),before);
  c.slots[0].attention='any';r=P.generate(s,c);assert.equal(r.issue.index,1);assert.equal(r.issue.diagnosis.fixable.attention,4);
  s.films.m1.nightTags={attention:'easy'};r=P.generate(s,c);assert.equal(r.ok,true);assert.equal(r.config.slots[1].film,'m1');assert.equal(s.films.m3.nightTags,undefined);
});

test('диагностика разделяет страну, ручные отметки, длительность и недоступные файлы',()=>{
  const s=state(),c=config(1);c.availability='only';c.slots[0].region='asia';c.slots[0].attention='medium';
  const f=s.films.m1;f.countries=[];f.runtime=null;delete f.nightTags;const d=P.analyzeCandidates(s,c,c.slots[0],'m1');
  assert.equal(d.excluded.countriesUnknown,1);assert.equal(d.excluded.attentionUnknown,1);assert.equal(d.excluded.runtime,1);assert.equal(d.excluded.availability,1);assert.equal(Object.keys(d.fixable).length,0);
  const reasons=P.explainFilm(s,c,c.slots[0],'m1').join(' ');assert.match(reasons,/страна/);assert.match(reasons,/внимания/);assert.match(reasons,/длительность/);assert.match(reasons,/диске/);
});

test('азиатский фильтр работает по старым русским названиям и ISO без привязки к языку имени режиссёра',()=>{
  const s=state(),c=config(1);c.slots[0].director='1';c.slots[0].region='asia';c.slots[0].attention='medium';s.directors[1].name='大島渚';
  for(const country of ['Япония','Japan']){s.films.m1.countries=[country];assert.equal(P.generate(s,c).ok,true,country);}
  s.films.m1.countryCodes=['JP'];s.films.m1.countries=[];assert.equal(P.generate(s,c).ok,true);s.films.m1.countryCodes=['FR'];const r=P.generate(s,c);assert.match(r.message,/Другой кинематограф/);
});

test('ошибки закрепления и замены отличаются от отсутствия подходящих фильмов',()=>{
  const s=state(),c=config(1);c.slots[0].film='missing';c.slots[0].locked=true;let r=P.generate(s,c);assert.equal(r.issue.kind,'kept');assert.match(r.message,/больше не найден/);
  c.slots[0].locked=false;c.slots[0].film='m1';c.slots[0].director='1';r=P.generate(s,c,{replace:0});assert.equal(r.issue.kind,'replacement');assert.match(r.message,/Другого варианта нет/);
});

test('подбор объясняет слишком короткий лимит и недостаток разных фильмов/режиссёров',()=>{
  const s=state(),c=config(2);s.files={};c.limit=180;let r=P.generate(s,c);assert.equal(r.issue.kind,'time');assert.equal(r.issue.minimumTime,190);assert.match(r.message,/190/);
  c.limit=0;c.count=9;c.slots=Array.from({length:9},P.slot);r=P.generate(s,c);assert.match(r.message,/9 мест.*8 разных/);
  c.limit=480;c.count=4;c.slots=Array.from({length:4},P.slot);Object.values(s.films).forEach((f,i)=>{f.dir=i%2+1;f.directorIds=[f.dir];});r=P.generate(s,c);assert.match(r.message,/только 2 режиссёров/);c.repeat=true;assert.equal(P.generate(s,c).ok,true);
});

test('отказ generateNight не меняет библиотеку, оценки, черновик и утверждённые ночи',()=>{
  const s=svc(),c=config();s.state.films.m1.rating=9;s.saveNightDraft(c);c.slots[0].attention='medium';Object.values(s.state.films).forEach(f=>delete f.nightTags);const before=JSON.stringify(s.state);const r=s.generateNight(c);assert.equal(r.ok,false);assert.match(r.message,/отметка внимания/);assert.equal(JSON.stringify(s.state),before);
});

// File transfer safety checks are part of the standard test command.
require("./transfers.test");
