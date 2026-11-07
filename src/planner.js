'use strict';
(function (root) {
  const GENRES = {28:'Боевик',12:'Приключения',16:'Анимация',35:'Комедия',80:'Криминал',99:'Документальный',18:'Драма',10751:'Семейный',14:'Фэнтези',36:'История',27:'Ужасы',10402:'Музыка',9648:'Детектив',10749:'Мелодрама',878:'Фантастика',10770:'Телефильм',53:'Триллер',10752:'Военный',37:'Вестерн'};
  const EN = {28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Science Fiction',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'};
  const REGIONS = {
    europe: 'AL AD AT BY BE BA BG HR CY CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH TR UA GB AX'.split(' '),
    asia: 'AF AM AZ BH BD BT BN KH CN GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE'.split(' '),
    america: 'US CA MX GL BM AG AI AW BS BB BZ BO BQ BR VG KY CL CO CR CU CW DM DO EC SV FK GF GD GP GT GY HT HN JM MQ MS NI PA PY PE PR BL KN LC MF PM VC SX SR TT TC UY VI VE'.split(' '),
  };
  const ISO = [...new Set([...Object.values(REGIONS).flat(),...'AU NZ ZA EG MA TN DZ NG KE ET TZ UG CD ZM ZW NA BW MZ MG MU SN GH CM AO SD SS LY SO'.split(' ')])];
  const names = new Map();
  for (const code of ISO) { names.set(code.toLowerCase(),code); for(const lang of ['ru','en'])try{names.set(new Intl.DisplayNames([lang],{type:'region'}).of(code).toLowerCase(),code);}catch{} }
  for(const [name,code] of Object.entries({'сша':'US','россия':'RU','российская федерация':'RU','ссср':'SU','soviet union':'SU','south korea':'KR','north korea':'KP','czechoslovakia':'CS','чехословакия':'CS','yugoslavia':'YU','югославия':'YU'}))names.set(name,code);
  for(const lang of ['ru','en']){const display=new Intl.DisplayNames([lang],{type:'region'});for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){const code=String.fromCharCode(a,b);const name=display.of(code);if(name&&name!==code&&!names.has(name.toLowerCase()))names.set(name.toLowerCase(),code);}}
  REGIONS.europe.push('SU','CS','YU');REGIONS.asia.push('SU');
  const within = (file,dir) => {const p=String(file||'').replace(/\\/g,'/').toLowerCase(),d=String(dir||'').replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();return !!d&&(p===d||p.startsWith(d+'/'));};
  const codeOf = x => names.get(String(x||'').toLowerCase()) || String(x||'');
  const title = f => f.userTitle || f.tmdbTitle || f.originalTitle || 'Без названия';
  const slot = () => ({ source:'inherit',region:'any',country:'any',genre:'any',weight:'any',attention:'any',director:'any',film:null,locked:false });
  const defaults = () => ({count:4,limit:480,pause:10,source:'nearfirst',nearCount:2,availability:'prefer',mode:'any',repeat:false,rewatch:false,allowFilmography:false,slots:Array.from({length:4},slot)});
  const oneOf = (v,list) => list.includes(v);
  function validate(c) {
    if(!c||!Number.isInteger(c.count)||c.count<1||c.count>20)throw Error('Выбери от 1 до 20 мест. Количество можно изменить.');
    if(!Number.isInteger(c.limit)||c.limit<0||c.limit>10080||!Number.isInteger(c.pause)||c.pause<0||c.pause>180)throw Error('Проверь время и перерывы.');
    if(!oneOf(c.source,['all','near','nearfirst','mix'])||!oneOf(c.availability,['prefer','only'])||!oneOf(c.mode,['any','favorites']))throw Error('Некорректные настройки подбора.');
    if(typeof c.repeat!=='boolean'||typeof c.rewatch!=='boolean'||typeof c.allowFilmography!=='boolean')throw Error('Некорректные переключатели.');
    if(!Array.isArray(c.slots)||c.slots.length!==c.count)throw Error('Число мест не совпадает с настройками.');
    if(!Number.isInteger(c.nearCount)||c.nearCount<0||c.nearCount>c.count)throw Error('Проверь количество из ближайших.');
    for(const s of c.slots){if(!s||typeof s.locked!=='boolean'||typeof s.country!=='string'||!(s.country==='any'||/^[A-Z]{2}$/.test(s.country))||!oneOf(s.source,['inherit','near','rest','rewatch'])||!oneOf(s.region,['any',...Object.keys(REGIONS)])||!oneOf(s.weight,['any','light','medium','heavy'])||!oneOf(s.attention,['any','easy','medium','focused'])||!(s.genre==='any'||s.genre==='crime-thriller'||s.genre==='noir'||s.genre==='neonoir'||Object.hasOwn(GENRES,s.genre)))throw Error('Проверь условия места.');}
    return c;
  }
  function fileIsAvailable(state,e){return e.state==='linked'&&!Object.values(state.lost||{}).some(l=>within(e.path,l.path))&&!(state.folders||[]).some(d=>['offline','suspicious'].includes(d.status)&&within(e.path,d.path));}
  const ATTENTION = ['easy','medium','focused'];
  const REASONS = {
    status:'Фильм не разрешён для просмотра или пересмотра', filmography:'Фильм только в фильмографии, вне активной библиотеки',
    banned:'Для режиссёра отключены предложения', favorites:'Режиссёр не отмечен любимым', director:'Другой режиссёр', source:'Фильм не входит в выбранный источник',
    availability:'Нет файла на доступном диске', runtime:'Неизвестна длительность при включённом лимите времени',
    countriesUnknown:'Не указана страна производства', region:'Другой кинематограф', country:'Другая страна',
    genre:'Не подходит жанр', style:'Нет вашей отметки выбранного нуара/неонуара',
    weightUnknown:'Не задана ваша отметка эмоциональной нагрузки', weight:'Другая эмоциональная нагрузка',
    attentionUnknown:'Не задана ваша отметка внимания', attention:'Требует больше внимания, чем выбрано сегодня',
  };
  const FILTER_FIELD = {availability:'availability',runtime:'limit',countriesUnknown:'region',region:'region',country:'country',genre:'genre',style:'genre',weightUnknown:'weight',weight:'weight',attentionUnknown:'attention',attention:'attention'};
  function collectCandidates(state,c,s,onlyKey=null) {
    const near = new Set((state.near||[]).flatMap(e=>e.ids));
    const byFilm=new Map();for(const e of Object.values(state.files||{})){if(e.state==='linked'){if(!byFilm.has(e.filmKey))byFilm.set(e.filmKey,[]);byFilm.get(e.filmKey).push(e);}}
    const base={},excluded={},fixable={};let scope=0,total=0;
    const baseReject=code=>{base[code]=(base[code]||0)+1;return [];};
    const rows=Object.values(state.films||{}).filter(f=>onlyKey===null||f.key===onlyKey).flatMap(f=>{
      total++;
      const reviewed=['watched','dropped'].includes(f.status), explicitRewatch=s.source==='rewatch'||c.rewatch;
      if(['nointerest','notfound'].includes(f.status)||reviewed&&!(f.rewatch&&explicitRewatch))return baseReject('status');
      if(!['queue','reserve','disk'].includes(f.status)&&!reviewed&&!(f.status==='candidate'&&c.allowFilmography&&String(s.director)===String(f.dir)))return baseReject('filmography');
      const dir=(state.directors||{})[f.dir];if(dir?.banned&&String(s.director)!==String(f.dir)&&!near.has(f.key))return baseReject('banned');
      if(c.mode==='favorites'&&!dir?.fav)return baseReject('favorites');
      if(s.director!=='any'&&String(f.dir)!==String(s.director))return baseReject('director');
      const isNear=near.has(f.key),src=s.source==='inherit'?c.source:s.source;
      if(src==='near'&&!isNear||src==='rest'&&isNear||src==='rewatch'&&!f.rewatch)return baseReject('source');
      scope++;
      const rejected=[];
      const copies=byFilm.get(f.key)||[],healthy=copies.filter(e=>fileIsAvailable(state,e));
      if(c.availability==='only'&&!healthy.length)rejected.push('availability');
      const durations=healthy.map(e=>e.duration).filter(n=>Number.isFinite(n)&&n>0);
      const runtime=f.nightTags?.runtime|| (durations.length?Math.max(...durations):f.runtime)||0;
      if(c.limit&&!runtime)rejected.push('runtime');
      if(s.region!=='any'||s.country!=='any'){
        const countries=(f.countryCodes?.length?f.countryCodes:f.countries||[]).map(codeOf);
        if(!countries.length)rejected.push('countriesUnknown');
        else {if(s.region!=='any'&&!countries.some(x=>REGIONS[s.region].includes(x)))rejected.push('region');if(s.country!=='any'&&!countries.includes(s.country))rejected.push('country');}
      }
      if(['noir','neonoir'].includes(s.genre)){if(!(f.nightTags?.styles||[]).includes(s.genre))rejected.push('style');}
      else if(s.genre!=='any'){
        const genres=new Set([...(f.genreIds||[]).map(String),...Object.keys(GENRES).filter(id=>(f.genres||[]).some(g=>g.toLowerCase()===GENRES[id].toLowerCase()||g.toLowerCase()===EN[id].toLowerCase()))]);
        if(s.genre==='crime-thriller'?!['80','53'].every(x=>genres.has(x)):!genres.has(s.genre))rejected.push('genre');
      }
      if(s.weight!=='any'){
        if(!['light','medium','heavy'].includes(f.nightTags?.weight))rejected.push('weightUnknown');
        else if(f.nightTags.weight!==s.weight)rejected.push('weight');
      }
      if(s.attention!=='any'){
        const level=ATTENTION.indexOf(f.nightTags?.attention);
        if(level<0)rejected.push('attentionUnknown');else if(level>ATTENTION.indexOf(s.attention))rejected.push('attention');
      }
      if(rejected.length){
        rejected.forEach(code=>{excluded[code]=(excluded[code]||0)+1;});
        const fields=new Set(rejected.map(code=>code==='countriesUnknown'?(s.region!=='any'&&s.country!=='any'?'geography':s.region!=='any'?'region':'country'):FILTER_FIELD[code]));
        if(fields.size===1){const field=[...fields][0];fixable[field]=(fixable[field]||0)+1;}
        return [];
      }
      const reasons=[isNear?'Из ближайших':f.status==='queue'?'Из активной очереди':reviewed?'Разрешён пересмотр':'Из библиотеки',healthy.length?'Есть на доступном диске':copies.length?'Наличие нужно проверить':state.allConnected?'Нужно скачать':'На подключённых дисках не найден'];
      if(dir?.fav)reasons.push('Любимый режиссёр');if(f.wish)reasons.push('Отмечен «Хочу»');
      return [{key:f.key,runtime,available:!!healthy.length,copies:copies.map(e=>e.id),near:isNear,dirs:(f.directorIds?.length?f.directorIds:[f.dir]).filter(d=>d!==null&&d!==undefined),reasons,score:(healthy.length?100:0)+(f.status==='queue'?18:0)+(c.source==='nearfirst'&&isNear?32:0)+(f.wish?12:0)}];
    });
    return {rows,total,scope,base,excluded,fixable};
  }
  function candidates(state,c,s){return collectCandidates(state,c,s).rows;}
  function analyzeCandidates(state,c,s,onlyKey=null){
    const data=collectCandidates(state,c,s,onlyKey);
    const counts=data.scope?data.excluded:data.base;
    const reasons=Object.entries(counts).map(([code,count])=>({code,count,label:REASONS[code]}));
    const details=reasons.map(r=>`${r.label}: ${r.count}`).join('; ');
    const summary=data.rows.length?`Подходящих фильмов: ${data.rows.length}.`:!data.total?'В библиотеке нет фильмов.':`Нет подходящих фильмов. ${details}.`;
    return {...data,reasons,summary};
  }
  function explainFilm(state,c,s,key){const d=analyzeCandidates(state,c,s,key);return d.total?d.reasons.map(r=>r.label):['Фильм больше не найден в библиотеке'];}
  function check(state,c,keys=c.slots.map(s=>s.film)) {
    validate(c);const errors=[],rows=[];if(keys.length!==c.count||keys.some(k=>!k))errors.push('Заполни все места.');
    const used=new Set(),dirs=new Set(),groups=new Set();
    keys.forEach((k,i)=>{if(!k)return;const f=candidates(state,c,c.slots[i]).find(f=>f.key===k);if(!f){errors.push(`Место ${i+1}: ${explainFilm(state,c,c.slots[i],k).join('; ')}.`);return;}if(used.has(k))errors.push('Фильм повторяется.');used.add(k);if(!c.repeat&&f.dirs.some(d=>dirs.has(d)))errors.push('Режиссёр повторяется.');f.dirs.forEach(d=>dirs.add(d));for(const e of state.near||[]){if(e.ids.length>1&&e.ids.includes(k)){if(groups.has(e.key))errors.push('Два фильма из одной строки «или».');groups.add(e.key);}}rows.push(f);});
    const time=rows.reduce((n,f)=>n+f.runtime,0)+Math.max(0,rows.length-1)*c.pause;
    if(c.limit&&time>c.limit)errors.push(`Превышение лимита на ${time-c.limit} мин.`);
    if(c.source==='mix'&&rows.length===c.count&&rows.filter(f=>f.near).length!==c.nearCount)errors.push('Не выполнена пропорция источников.');
    return {errors:[...new Set(errors)],total:time,unknownRuntime:rows.some(f=>!f.runtime),rows};
  }
  function generate(state,input,{replace=null,seed=0,maxNodes=100000,timeBudgetMs=700}={}) {
    const c=validate(JSON.parse(JSON.stringify(input)));
    if(replace!==null&&(!Number.isInteger(replace)||replace<0||replace>=c.count||c.slots[replace].locked))throw Error('Сначала открепи место для замены.');
    const pools=c.slots.map((s,i)=>{
      const keep=s.locked||replace!==null&&i!==replace;
      const all=candidates(state,c,s);return all.filter(f=>keep?f.key===s.film:!(i===replace&&f.key===s.film)).map(f=>({...f,rank:f.score+((Number(String(f.key).replace(/\D/g,''))||0)*31+seed*17+i*7)%29/10})).sort((a,b)=>b.rank-a.rank);
    });
    const empty=pools.findIndex(p=>!p.length);
    if(empty>=0){
      const slot=c.slots[empty],diagnosis=analyzeCandidates(state,c,slot);
      let message=diagnosis.summary,kind='filters';
      if(slot.locked||replace!==null&&empty!==replace){
        kind='kept';message=!slot.film?'Место ещё не заполнено. Сначала подбери всю ночь или выбери фильм вручную.':`Сохранённый фильм не подходит: ${explainFilm(state,c,slot,slot.film).join('; ')}. Открепи его или измени условия.`;
      }else if(empty===replace&&diagnosis.rows.length){kind='replacement';message='Другого варианта нет: текущим условиям соответствует только выбранный фильм.';}
      return {ok:false,message:`Место ${empty+1}: ${message}`,issue:{kind,index:empty,diagnosis},config:c};
    }
    const order=pools.map((_,i)=>i).sort((a,b)=>pools[a].length-pools[b].length),chosen=Array(c.count).fill(null);
    let best=null,bestScore=-Infinity,nodes=0,bounded=false;
    const deadline=Date.now()+Math.min(1500,Math.max(1,timeBudgetMs));
    const minima=pools.map(p=>p.reduce((n,f)=>Math.min(n,f.runtime),Infinity));
    const minimumTime=minima.reduce((a,b)=>a+b,0)+Math.max(0,c.count-1)*c.pause;
    if(c.limit&&minimumTime>c.limit)return {ok:false,message:`Лимит ${c.limit} мин слишком мал: даже самые короткие варианты для каждого места с перерывами требуют не меньше ${minimumTime} мин. Увеличь лимит или сократи число фильмов.`,issue:{kind:'time',minimumTime},config:c};
    const uniqueFilms=new Set(pools.flat().map(r=>r.key)).size,uniqueDirs=new Set(pools.flat().flatMap(r=>r.dirs)).size;
    if(uniqueFilms<c.count)return {ok:false,message:`Для ${c.count} мест найдено только ${uniqueFilms} разных подходящих фильмов. Расширь условия или сократи число мест.`,issue:{kind:'combination'},config:c};
    if(!c.repeat&&pools.flat().every(r=>r.dirs.length)&&uniqueDirs<c.count)return {ok:false,message:`Для ${c.count} мест доступны фильмы только ${uniqueDirs} режиссёров, а повтор запрещён. Разреши повтор режиссёра или измени условия.`,issue:{kind:'combination'},config:c};
    const dfs=(depth,time,score,used,dirs,groups,near)=>{
      if(++nodes>Math.min(maxNodes,1000000)||Date.now()>deadline){bounded=true;return;}
      if(depth===order.length){if(c.source==='mix'&&near!==c.nearCount)return;if(score>bestScore){bestScore=score;best=chosen.slice();}return;}
      const i=order[depth];for(const f of pools[i]){
        if(Date.now()>deadline){bounded=true;return;}
        if(used.has(f.key)||!c.repeat&&f.dirs.some(d=>dirs.has(d)))continue;
        const gs=(state.near||[]).filter(e=>e.ids.length>1&&e.ids.includes(f.key)).map(e=>e.key);if(gs.some(g=>groups.has(g)))continue;
        const t=time+f.runtime+(depth?c.pause:0),n=near+Number(f.near);if(c.limit&&t>c.limit)continue;if(c.source==='mix'&&(n>c.nearCount||n+c.count-depth-1<c.nearCount))continue;
        const remaining=order.slice(depth+1);if(c.limit&&t+remaining.reduce((sum,j)=>sum+minima[j]+c.pause,0)>c.limit)continue;
        // Upper bound prunes only scores, never relaxes user constraints.
        if(score+f.rank+remaining.reduce((sum,j)=>sum+pools[j][0].rank,0)<=bestScore)continue;
        chosen[i]=f.key;dfs(depth+1,t,score+f.rank,new Set([...used,f.key]),new Set([...dirs,...f.dirs]),new Set([...groups,...gs]),n);
      }
    };
    dfs(0,0,0,new Set(),new Set(),new Set(),0);
    if(!best){
      const message=bounded?'За отведённое время набор не подобран. Уточни условия или сократи число мест.':'Для отдельных мест варианты есть, но совместимый набор не найден: проверь общий лимит, повторы режиссёров, альтернативы «или» и смесь источников.';
      return {ok:false,message,issue:{kind:bounded?'budget':'combination'},config:c};
    }
    c.slots.forEach((s,i)=>s.film=best[i]);return {ok:true,config:c,...check(state,c),bounded};
  }
  const api={GENRES,REGIONS,codeOf,fileIsAvailable,defaults,slot,validate,candidates,analyzeCandidates,explainFilm,check,generate,title};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.NightPlanner=api;
})(globalThis);
