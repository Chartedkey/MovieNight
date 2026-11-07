'use strict';
(function(root){
  const fields=['name','userName','tmdbName','sortSurname','nameReviewed'];
  const reviewed=d=>d.nameReviewed===undefined?!!d.userName:!!d.nameReviewed;
  const version=d=>JSON.stringify([d.name||'',d.userName||null,d.tmdbName||d.name||'',d.sortSurname||null,reviewed(d)]);
  const snapshot=d=>Object.fromEntries(fields.filter(k=>Object.hasOwn(d,k)).map(k=>[k,d[k]]));
  const hasCyrillic=name=>/[А-Яа-яЁё]/.test(String(name||''));
  const api={fields,reviewed,version,snapshot,hasCyrillic};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DirectorIdentity=api;
})(globalThis);
