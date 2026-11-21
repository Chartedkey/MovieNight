'use strict';
(function(root){
  const canonical=p=>String(p||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  const within=(p,dir)=>canonical(p)===canonical(dir)||canonical(p).startsWith(canonical(dir)+'/');
  const roots=state=>(state.folders||[]).filter(f=>f.role==='archive');
  function isArchive(state,e){return e.role==='archive'||roots(state).some(f=>within(e.path,f.path));}
  function pending(state){
    const local=new Set(Object.values(state.files||{}).filter(e=>e.state==='linked'&&!isArchive(state,e)).map(e=>e.filmKey));
    return Object.values(state.films||{}).filter(f=>['queue','reserve'].includes(f.status)&&!local.has(f.key));
  }
  function hits(state,key){return Object.values(state.archiveEntries||{}).filter(e=>roots(state).some(f=>canonical(f.path)===canonical(e.root))&&!(e.rejected||[]).includes(key)&&(e.confirmedKey?e.confirmedKey===key:e.candidates.includes(key)));}
  function groups(state){const found=[],possible=[],missing=[];for(const f of pending(state)){const entries=hits(state,f.key);(entries.some(e=>e.confirmedKey===f.key)?found:entries.length?possible:missing).push(f);}return {found,possible,missing};}
  const api={canonical,within,roots,isArchive,pending,hits,groups};
  if(typeof module==='object'&&module.exports){
    const fs=require('fs'),path=require('path'),{createHash}=require('crypto');
    const {parseName,MIN_FILM_BYTES,VIDEO,SKIP_DIRS,BONUS_DIR,BONUS_FILE,EPISODE,PART}=require('./scanner');
    const {norm}=require('./matcher');
    const identity=p=>createHash('sha256').update(process.platform==='win32'?p.toLowerCase():p).digest('hex');
    function similarName(a,b){
      if(Math.min(a.length,b.length)<5||Math.max(a.length,b.length)>220)return false;
      if(Math.min(a.length,b.length)>=8&&Math.min(a.length,b.length)/Math.max(a.length,b.length)>=0.5&&(` ${a} `.includes(` ${b} `)||` ${b} `.includes(` ${a} `)))return true;
      const limit=Math.min(a.length,b.length)<12?1:2;
      if(Math.abs(a.length-b.length)>limit)return false;
      let row=Array.from({length:b.length+1},(_,i)=>i);
      for(let i=1;i<=a.length;i++){
        const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(a[i-1]!==b[j-1]));
        if(Math.min(...next)>limit)return false;row=next;
      }
      return row[b.length]<=limit;
    }
    function candidates(index,fuzzyIndex,names){
      const matches=new Map();
      for(const name of names){
        const title=norm(name.title);if(!title)continue;
        const exactName=index.has(title);
        const found=exactName?index.get(title):[...new Set([...fuzzyIndex].filter(([other])=>similarName(title,other)).flatMap(([,films])=>films))];
        for(const f of found){
          if(name.year&&f.year&&Math.abs(name.year-f.year)>1)continue;
          const exact=exactName&&!!name.year&&name.year===f.year;
          matches.set(f.key,exact||matches.get(f.key)||false);
        }
      }
      return matches;
    }
    api.archiveMethods={
      async checkArchive(onlyPath){
        if(this.scanning||this.running||this.transferBusy)throw Error('Дождись завершения сканирования, импорта или переноса.');
        const folders=roots(this.state).filter(f=>!onlyPath||canonical(f.path)===canonical(onlyPath));
        if(!folders.length)throw Error('Добавь папки с ролью «Резервный NAS» в разделе «Диски → Папки».');
        const targets=new Set(pending(this.state).map(f=>f.key));
        if(!targets.size)throw Error('В списке «Скачать» нет фильмов для проверки.');
        const index=new Map();
        for(const f of Object.values(this.state.films))for(const name of new Set([f.userTitle,f.tmdbTitle,f.originalTitle,...(f.altTitles||[])].map(norm).filter(Boolean))){if(!index.has(name))index.set(name,[]);index.get(name).push(f);}
        const fuzzyIndex=new Map([...index].map(([name,films])=>[name,films.filter(f=>targets.has(f.key))]).filter(([,films])=>films.length));
        this.scanning=true;this.archiveChecking=true;this.archiveStop=false;
        this.state.archiveEntries=this.state.archiveEntries||{};this.state.archiveChecks=this.state.archiveChecks||{};
        try{
          for(const folder of folders){
            if(this.archiveStop)break;
            const rootPath=folder.path,checkedAt=new Date().toISOString(),fresh={},errors=[];
            let dirs=0,files=0,lastProgress=0;
            const excluded=this.folders().filter(f=>f.role==='exclude'||canonical(f.path)!==canonical(rootPath)&&within(f.path,rootPath)).map(f=>f.path);
            const record=(p,names,stat,kind)=>{
              const id=identity(p),old=this.state.archiveEntries[id];
              const matches=candidates(index,fuzzyIndex,names),keys=[...matches.keys()].filter(k=>targets.has(k)||old?.candidates.includes(k));if(!keys.length)return;
              const fingerprint=`${stat.size}:${stat.mtimeMs}:${kind}`;
              const unchanged=old?.fingerprint===fingerprint&&canonical(old.root)===canonical(rootPath);
              const rejected=unchanged?(old.rejected||[]):[];
              const confirmedKey=unchanged&&old.manual&&keys.includes(old.confirmedKey)?old.confirmedKey:matches.size===1&&matches.get(keys[0])&&!rejected.includes(keys[0])?keys[0]:null;
              fresh[id]={id,root:rootPath,path:p,title:names[0].title,year:names[0].year,kind,fingerprint,candidates:keys,confirmedKey,rejected,manual:!!(unchanged&&old.manual),checkedAt};
            };
            const walk=async(dir,isRoot=false)=>{
              if(this.archiveStop)return;
              if(excluded.some(p=>within(dir,p)))return;
              let items;try{items=await fs.promises.readdir(dir,{withFileTypes:true});}catch(e){if(isRoot)throw e;errors.push(dir);return;}
              dirs++;if(Date.now()-lastProgress>100){lastProgress=Date.now();this.onScan?.({archive:true,running:true,current:dir,found:Object.keys(fresh).length,dirs});}
              items=items.filter(e=>!excluded.some(p=>within(path.join(dir,e.name),p))&&!e.isSymbolicLink()&&!SKIP_DIRS.has(e.name.toLowerCase())&&!e.name.startsWith('.')&&!BONUS_DIR.test(e.name));
              const disc=items.some(e=>e.isDirectory()&&['video_ts','bdmv'].includes(e.name.toLowerCase()))||items.some(e=>e.isFile()&&/^VTS_\d{2}_[1-9]\.VOB$/i.test(e.name));
              if(disc){
                try{
                  const marker=items.find(e=>e.isDirectory()&&['video_ts','bdmv'].includes(e.name.toLowerCase()));
                  let videoDir=dir;
                  if(marker){videoDir=path.join(dir,marker.name);if(marker.name.toLowerCase()==='bdmv'){const children=await fs.promises.readdir(videoDir,{withFileTypes:true});const stream=children.find(e=>e.isDirectory()&&e.name.toLowerCase()==='stream');if(!stream)return;videoDir=path.join(videoDir,stream.name);}}
                  const streams=await fs.promises.readdir(videoDir,{withFileTypes:true});
                  for(const entry of streams.filter(e=>e.isFile()&&/\.(vob|m2ts)$/i.test(e.name))){const stat=await fs.promises.stat(path.join(videoDir,entry.name));if(stat.size>=MIN_FILM_BYTES){record(dir,[parseName(path.basename(dir),false)],stat,'disc');break;}}
                }catch{errors.push(dir);}return;
              }
              const videos=items.filter(e=>e.isFile()&&VIDEO.has(path.extname(e.name).toLowerCase())&&!BONUS_FILE.test(e.name)&&!EPISODE.test(e.name));
              for(const entry of videos){
                if(this.archiveStop)return;
                const p=path.join(dir,entry.name);try{
                  const stat=await fs.promises.stat(p);files++;if(stat.size<MIN_FILM_BYTES)continue;
                  const names=[parseName(entry.name,true)];if((videos.length===1||videos.length>1&&videos.every(e=>PART.test(e.name)))&&!isRoot)names.push(parseName(path.basename(dir),false));
                  record(p,names,stat,'file');
                }catch{errors.push(p);}
              }
              for(const entry of items)if(entry.isDirectory())await walk(path.join(dir,entry.name));
            };
            let status='ok';try{await walk(rootPath,true);if(errors.length)status='partial';}catch{status='offline';errors.push(rootPath);}
            if(this.archiveStop)status='cancelled';
            const previous=Object.values(this.state.archiveEntries).filter(e=>canonical(e.root)===canonical(rootPath));
            const missing=previous.filter(e=>!fresh[e.id]);
            // A disconnected mount can look like an empty directory. Keep previous evidence until confirmed.
            if(status==='ok'&&previous.length&&missing.length>=Math.max(1,Math.ceil(previous.length/2)))status='suspicious';
            if(status==='ok')for(const old of previous)delete this.state.archiveEntries[old.id];
            Object.assign(this.state.archiveEntries,fresh);
            this.state.archiveChecks[canonical(rootPath)]={root:rootPath,status,checkedAt,dirs,files,errors,missing:status==='suspicious'?missing.map(e=>e.id):[]};
            this.save();
          }
          return this.state;
        }finally{this.scanning=false;this.archiveChecking=false;this.onScan?.({archive:true,running:false});}
      },
      stopArchiveCheck(){this.archiveStop=true;return true;},
      resolveArchiveEntry(id,key,confirmed){
        if(this.scanning||this.transferBusy)throw Error('Дождись завершения проверки или переноса.');
        const e=this.state.archiveEntries?.[id];if(!e||!hits(this.state,key).some(x=>x.id===id)||typeof confirmed!=='boolean')throw Error('Совпадение устарело. Обнови список.');
        if(confirmed){e.confirmedKey=key;e.manual=true;}else{e.rejected=[...new Set([...(e.rejected||[]),key])];if(e.confirmedKey===key)e.confirmedKey=null;e.manual=false;}
        this.save();return this.state;
      },
      confirmArchiveMissing(rootPath){
        if(this.scanning||this.transferBusy)throw Error('Дождись завершения проверки или переноса.');
        const check=this.state.archiveChecks?.[canonical(rootPath)];if(check?.status!=='suspicious'||!roots(this.state).some(f=>canonical(f.path)===canonical(rootPath)))throw Error('Сначала проверь резервную папку.');
        for(const id of check.missing)if(canonical(this.state.archiveEntries[id]?.root)===canonical(rootPath))delete this.state.archiveEntries[id];check.missing=[];check.status='ok';this.save();return this.state;
      },
    };
    module.exports=api;
  }else root.ArchiveCatalog=api;
})(globalThis);
