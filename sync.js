/* =====================================================================
   KAYANI POS — stockage local et synchronisation (hors ligne d'abord)
   - Toutes les données vivent dans IndexedDB sur l'appareil : l'application
     fonctionne sans réseau.
   - Chaque modification est mise dans une file d'attente (outbox), envoyée à
     Supabase dès que la connexion revient, puis les changements des autres
     appareils sont récupérés (tirage par numéro de révision `rev`).
   - Sans fichier config.js renseigné, l'application tourne en mode démo
     (données fictives en mémoire), comme le prototype.
   ===================================================================== */
(function(){
const CFG=window.KAYANI_CONFIG||{};
const PROD=!!(CFG.supabaseUrl&&CFG.supabaseAnonKey);
const DB_NAME='kayani-pos',DB_VER=1;
const LS=k=>'kayani.'+k;
const lsGet=k=>{try{return localStorage.getItem(LS(k))}catch(e){return null}};
const lsSet=(k,v)=>{try{v===null?localStorage.removeItem(LS(k)):localStorage.setItem(LS(k),v)}catch(e){}};

/* Code appareil : sert aux numéros de reçus émis hors ligne (REC-2026-K3-00012) */
function deviceCode(){let d=lsGet('device');if(!d){const L='ABCDEFGHJKLMNPQRSTUVWXYZ';d=L[Math.floor(Math.random()*L.length)]+Math.floor(Math.random()*9+1);lsSet('device',d)}return d}

/* ---------- IndexedDB minimal ---------- */
let dbp=null;
function db(){if(dbp)return dbp;dbp=new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,DB_VER);r.onupgradeneeded=()=>{const d=r.result;
  if(!d.objectStoreNames.contains('records'))d.createObjectStore('records',{keyPath:'k'});
  if(!d.objectStoreNames.contains('outbox'))d.createObjectStore('outbox',{keyPath:'k'});
  if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'k'})};
  r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});return dbp}
function tx(stores,mode,fn){return db().then(d=>new Promise((res,rej)=>{const t=d.transaction(stores,mode);const out=fn(t);t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)}))}
const getAll=store=>db().then(d=>new Promise((res,rej)=>{const r=d.transaction(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
const metaGet=k=>db().then(d=>new Promise(res=>{const r=d.transaction('meta').objectStore('meta').get(k);r.onsuccess=()=>res(r.result?r.result.v:undefined);r.onerror=()=>res(undefined)}));
const metaSet=(k,v)=>tx(['meta'],'readwrite',t=>t.objectStore('meta').put({k,v}));

/* ---------- Correspondance collections ↔ état de l'application ---------- */
// Chaque collection : où la lire dans S, et comment la remettre en place.
const COLS=[
 ['clients','clients'],['sales','sales'],['payments','payments'],['invoices','invoices'],['quotes','quotes'],
 ['expenses','expenses'],['stock_moves','stockMoves'],['bookings','bookings'],['memberships','memberships'],
 ['advances','advances'],['services','services'],['products','products'],['audit','audit'],['cash','cashSessions'],
 ['credits','credits'],['team','team'],['presence','presence'],['team_events','teamEvents'],['attendance','attendance'],
 ['gcal','gcal'], // état de synchronisation Google Agenda, écrit par la fonction gcal-sync (lecture seule ici)
];
const keyOf=(c,id)=>c+'|'+id;
// Empreinte indépendante de l'ordre des clés (Supabase/jsonb réordonne les clés)
const sortKeys=v=>Array.isArray(v)?v.map(sortKeys):v&&typeof v==='object'?Object.keys(v).sort().reduce((o,k)=>(v[k]!==undefined&&(o[k]=sortKeys(v[k])),o),{}):v;
const stable=v=>JSON.stringify(sortKeys(v));
let S=null,hooks={};
let hashes=new Map();           // dernière version connue de chaque enregistrement (JSON)
let pending=new Set();          // clés présentes dans la file d'attente
let state={online:navigator.onLine,syncing:false,lastSync:null,pending:0,error:'',rejected:0};
let sb=null,timer=null,persistT=null,again=false;

function strip(c,r){
 if(c==='cash'){const {moves,...rest}=r;return rest}
 if(c==='products'){const {stock,...rest}=r;return rest}   // le stock se recalcule à partir des mouvements
 return r;
}
function* iterRecords(){
 for(const [c,key] of COLS){const arr=S[key]||[];for(const r of arr){if(r&&r.id)yield [c,r.id,strip(c,r)]}}
 for(const sess of (S.cashSessions||[]))for(const m of (sess.moves||[]))yield ['cash_moves',m.id,{...m,sessionId:sess.id}];
 yield ['settings','main',{id:'main',settings:S.settings,perms:S.perms}];
}

/* Repère les enregistrements nouveaux ou modifiés depuis le dernier passage et les place dans la file d'attente */
async function persist(){
 if(!PROD||!S||!hooks.ready)return;
 const changes=[];
 for(const [c,id,data] of iterRecords()){const j=stable(data);const k=keyOf(c,id);if(hashes.get(k)!==j){hashes.set(k,j);changes.push({k,c,id,data})}}
 if(!changes.length)return;
 await tx(['records','outbox'],'readwrite',t=>{const rs=t.objectStore('records'),ob=t.objectStore('outbox');
  for(const ch of changes){rs.put({k:ch.k,c:ch.c,id:ch.id,data:ch.data});ob.put({k:ch.k,c:ch.c,id:ch.id,data:ch.data,at:Date.now()});pending.add(ch.k)}});
 state.pending=pending.size;hooks.status&&hooks.status();
 schedule(800);
}
function schedulePersist(){if(!PROD)return;clearTimeout(persistT);persistT=setTimeout(()=>persist().catch(e=>console.error('persist',e)),250)}

/* Reconstruit l'état S à partir des enregistrements locaux */
function applyRecords(rows){
 const by={};for(const r of rows){(by[r.c]=by[r.c]||[]).push(r.data)}
 for(const [c,key] of COLS){if(by[c])S[key]=by[c]}
 const moves=by.cash_moves||[];
 (S.cashSessions||[]).forEach(s=>{s.moves=moves.filter(m=>m.sessionId===s.id).map(({sessionId,...m})=>m).sort((a,b)=>(a.at||a.time).localeCompare(b.at||b.time))});
 if(by.settings&&by.settings[0]){const st=by.settings[0];if(st.settings)S.settings=Object.assign(S.settings,st.settings);if(st.perms)S.perms=Object.assign(S.perms,st.perms)}
 hooks.rebuild&&hooks.rebuild();
}
function mergeRemote(rows){
 // Un enregistrement encore en attente d'envoi garde sa version locale.
 const byKey=new Map();for(const r of rows){const k=keyOf(r.collection,r.id);if(!pending.has(k))byKey.set(k,r)}
 if(!byKey.size)return 0;
 for(const [k,r] of byKey){
  const c=r.collection,data=r.data;
  if(c==='settings'){if(data.settings)Object.assign(S.settings,data.settings);if(data.perms)Object.assign(S.perms,data.perms)}
  else if(c==='cash_moves'){const sess=(S.cashSessions||[]).find(s=>s.id===data.sessionId);const {sessionId,...m}=data;
   if(sess){sess.moves=sess.moves||[];const i=sess.moves.findIndex(x=>x.id===m.id);if(i>=0)sess.moves[i]=m;else sess.moves.push(m)}
   else{(S._orphanMoves=S._orphanMoves||[]).push(data)}}
  else{const col=COLS.find(x=>x[0]===c);if(!col)continue;const arr=S[col[1]]=S[col[1]]||[];const i=arr.findIndex(x=>x.id===r.id);
   if(r.deleted){if(i>=0)arr.splice(i,1)}else if(i>=0){if(c==='cash'){data.moves=arr[i].moves||[]}arr[i]=data}else{if(c==='cash'){data.moves=[]}arr.push(data)}}
  hashes.set(k,c==='settings'?stable({id:'main',settings:S.settings,perms:S.perms}):stable(c==='cash_moves'?data:strip(c,data)));
 }
 // mouvements de caisse arrivés avant leur session
 if(S._orphanMoves&&S._orphanMoves.length){S._orphanMoves=S._orphanMoves.filter(d=>{const s=(S.cashSessions||[]).find(x=>x.id===d.sessionId);if(!s)return true;const {sessionId,...m}=d;if(!s.moves.some(x=>x.id===m.id))s.moves.push(m);return false})}
 hooks.rebuild&&hooks.rebuild();
 return byKey.size;
}

/* ---------- Synchronisation ---------- */
async function push(){
 const items=await getAll('outbox');if(!items.length)return 0;
 const dev=deviceCode();let sent=0;
 const audit=items.filter(i=>i.c==='audit'),rest=items.filter(i=>i.c!=='audit');
 const send=async(list,opts)=>{for(let i=0;i<list.length;i+=200){const chunk=list.slice(i,i+200);
   const rows=chunk.map(it=>({collection:it.c,id:it.id,data:it.data,device:dev}));
   let {error}=await sb.from('records').upsert(rows,opts);
   if(error&&/row-level security|permission|42501/i.test(error.message+error.code)){
    // envoi un par un pour isoler les lignes refusées par les droits
    for(const it of chunk){const r=await sb.from('records').upsert([{collection:it.c,id:it.id,data:it.data,device:dev}],opts);
     if(r.error){state.rejected++;console.warn('Refusé par les droits',it.k,r.error.message)}
     await tx(['outbox'],'readwrite',t=>t.objectStore('outbox').delete(it.k));pending.delete(it.k);sent++}
    continue}
   if(error)throw error;
   await tx(['outbox'],'readwrite',t=>{const ob=t.objectStore('outbox');chunk.forEach(it=>ob.delete(it.k))});
   chunk.forEach(it=>pending.delete(it.k));sent+=chunk.length}};
 await send(rest,{onConflict:'collection,id'});
 await send(audit,{onConflict:'collection,id',ignoreDuplicates:true});
 state.pending=pending.size;return sent;
}
async function pull(){
 let cursor=(await metaGet('cursor'))||0,total=0;
 for(;;){await persist(); // les saisies locales en cours passent en file d'attente avant la fusion
const {data,error}=await sb.from('records').select('collection,id,data,deleted,rev').gt('rev',cursor).order('rev',{ascending:true}).limit(1000);
  if(error)throw error;if(!data.length)break;
  await tx(['records'],'readwrite',t=>{const rs=t.objectStore('records');for(const r of data){const k=keyOf(r.collection,r.id);if(pending.has(k))continue;if(r.deleted)rs.delete(k);else rs.put({k,c:r.collection,id:r.id,data:r.data})}});
  total+=mergeRemote(data);cursor=data[data.length-1].rev;await metaSet('cursor',cursor);if(data.length<1000)break}
 return total;
}
async function sync(){
 if(!PROD||!sb||!hooks.ready)return;
 if(state.syncing){again=true;return}
 if(!navigator.onLine){state.online=false;hooks.status&&hooks.status();return}
 state.syncing=true;hooks.status&&hooks.status();
 try{await persist();await push();const n=await pull();state.lastSync=new Date();state.error='';state.online=true;
  if(n)hooks.changed&&hooks.changed();
 }catch(e){state.error=String(e.message||e);console.warn('sync',e);if(/fetch|network|Failed/i.test(state.error))state.online=false}
 finally{state.syncing=false;state.pending=pending.size;hooks.status&&hooks.status();if(again){again=false;schedule(100)}}
}
function schedule(ms){clearTimeout(timer);timer=setTimeout(sync,ms)}

/* ---------- Authentification ---------- */
async function signIn(email,password){
 const {data,error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;
 return loadProfile(data.user);
}
async function loadProfile(user){
 const {data,error}=await sb.from('profiles').select('id,email,name,role').eq('id',user.id).single();
 if(error)throw new Error('Profil introuvable : demandez à l\'administrateur de vérifier votre compte.');
 const p={id:data.id,email:data.email,name:data.name||data.email,role:data.role};
 if(p.role!=='admin'&&p.role!=='assistant'){try{await sb.auth.signOut()}catch(e){}throw new Error('Ce compte n\'est pas encore activé. Demandez à l\'administrateur de lui attribuer un rôle.')}
 // un autre utilisateur se connecte sur cet appareil : on repart d'une base locale vide
 const owner=lsGet('owner');if(owner&&owner!==p.id)await wipeLocal();
 lsSet('owner',p.id);lsSet('profile',JSON.stringify(p));
 const all=await sb.from('profiles').select('id,email,name,role');if(!all.error)lsSet('profiles',JSON.stringify(all.data));
 return p;
}
async function restore(){
 const {data}=await sb.auth.getSession();if(!data||!data.session)return null;
 let p=null;try{p=JSON.parse(lsGet('profile')||'null')}catch(e){}
 if(p&&p.id===data.session.user.id){if(navigator.onLine)loadProfile(data.session.user).then(np=>{if(np.role!==p.role)location.reload()}).catch(()=>{});return p}
 if(navigator.onLine)return loadProfile(data.session.user);
 return null;
}
async function signOut(force){
 await persist();
 if(pending.size&&!force)throw new Error(pending.size+' opération(s) pas encore synchronisée(s). Reconnectez-vous à Internet avant de vous déconnecter.');
 try{await sb.auth.signOut()}catch(e){}
 await wipeLocal();lsSet('profile',null);lsSet('owner',null);
}
async function wipeLocal(){await tx(['records','outbox','meta'],'readwrite',t=>{t.objectStore('records').clear();t.objectStore('outbox').clear();t.objectStore('meta').clear()});hashes.clear();pending.clear()}
function profiles(){try{return JSON.parse(lsGet('profiles')||'[]')}catch(e){return[]}}

/* Démarrage après connexion : charge la base locale puis synchronise */
async function start(state0){
 S=state0;
 const rows=await getAll('records');
 const ob=await getAll('outbox');ob.forEach(i=>pending.add(i.k));state.pending=pending.size;
 applyRecords(rows);
 for(const [c,id,data] of iterRecords())hashes.set(keyOf(c,id),stable(data));
 // les enregistrements en attente doivent rester « modifiés » pour être renvoyés tels quels
 hooks.ready=true;
 if(!rows.length&&navigator.onLine){await sync()}else{schedule(300)}
 setInterval(()=>sync(),20000);
}
async function legalNumber(prefix){
 if(!navigator.onLine)throw new Error('Connexion Internet requise : la numérotation des factures et avoirs doit rester continue.');
 const {data,error}=await sb.rpc('next_doc_number',{p_prefix:prefix});if(error)throw error;return data;
}

if(PROD&&window.supabase){sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,storageKey:'kayani-auth'}})}
window.addEventListener('online',()=>{state.online=true;hooks.status&&hooks.status();schedule(200)});
window.addEventListener('offline',()=>{state.online=false;hooks.status&&hooks.status()});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')schedule(200)});

window.Store={PROD,deviceCode,state,hooks,start,persist:schedulePersist,flush:persist,sync,signIn,restore,signOut,profiles,legalNumber,get client(){return sb}};
})();
