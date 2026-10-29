/* KAYANI POS — service worker : garde l'application en cache pour un usage hors ligne.
   Les données ne passent pas par ici (IndexedDB + Supabase). Changer VERSION à chaque mise en ligne. */
const VERSION='kayani-3.15.0';
const SHELL=['./','index.html','sync.js','config.js','manifest.webmanifest','supabase.js','fonts.css',
 'icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-32.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(SHELL)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting()});
self.addEventListener('fetch',e=>{
  const req=e.request;const url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==location.origin)return; // Supabase et autres domaines : réseau direct
  // seuls les fichiers de l'application sont mis en cache, jamais des données
  if(req.mode!=='navigate'&&!/\.(html|js|css|webmanifest|png|woff2|svg|ico)$/.test(url.pathname))return;
  if(req.mode==='navigate'){
    // page : réseau d'abord (version fraîche), cache si hors ligne
    e.respondWith(fetch(req).then(r=>{const cp=r.clone();caches.open(VERSION).then(c=>c.put('index.html',cp));return r}).catch(()=>caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req,{ignoreSearch:true}).then(hit=>hit||fetch(req).then(r=>{if(r.ok){const cp=r.clone();caches.open(VERSION).then(c=>c.put(req,cp))}return r})));
});
