// Test du point d'entrée HTTP : authentification, signature du jeton Google, appels REST.
// Lancer : node supabase/functions/gcal-sync/test/handler.test.mjs
globalThis.__KAYANI_TEST__ = true;
const m = await import('../index.ts');
let fails = 0; const ok = (c, msg) => { if (!c) { fails++; console.log('ÉCHEC :', msg); } };
const k = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey));
const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
Object.assign(process.env, { SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'k', GCAL_CALENDAR_ID: 'kayani.therapy@gmail.com', GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sync@kayani.iam.gserviceaccount.com', private_key: pem }) });
const state = { id: 1, secret: 'sec', sync_token: null, channel_id: 'chan' }; let assertion = '', locked = false, upserts = [], watched = null;
const users = { 'jwt-admin': { id: 'u1', role: 'admin' }, 'jwt-pending': { id: 'u2', role: 'pending' } };
globalThis.fetch = async (url, init = {}) => { const u = String(url), meth = init.method || 'GET';
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.includes('oauth2.googleapis.com')) { assertion = new URLSearchParams(init.body).get('assertion'); return J({ access_token: 'tok', expires_in: 3600 }); }
  if (u.includes('/events/watch')) { watched = JSON.parse(init.body); return J({ resourceId: 'r', expiration: String(Date.now() + 6 * 864e5) }); }
  if (u.includes('googleapis.com/calendar')) { ok(init.headers.Authorization === 'Bearer tok', 'jeton Google transmis'); return J({ items: [], nextSyncToken: 'x' }); }
  if (u.startsWith('http://db/auth/v1/user')) { const t = init.headers.Authorization.slice(7); return users[t] ? J({ id: users[t].id }) : J({}, 401); }
  if (u.startsWith('http://db/rest/v1/profiles')) { const id = u.match(/id=eq\.([^&]+)/)[1]; const x = Object.values(users).find((v) => v.id === id); return J(x ? [{ role: x.role }] : []); }
  if (u.startsWith('http://db/rest/v1/gcal_state')) { if (meth === 'PATCH') { Object.assign(state, JSON.parse(init.body)); return new Response(''); } return J([state]); }
  if (u.includes('rpc/gcal_try_lock')) { if (locked) return J(false); locked = true; return J(true); }
  if (u.includes('rpc/gcal_unlock')) { locked = false; return J(false); }
  if (u.includes('rpc/gcal_request_again')) return J(null);
  if (u.startsWith('http://db/rest/v1/records')) { if (meth === 'POST') { upserts.push(...JSON.parse(init.body)); return new Response(''); } return J([]); }
  throw new Error('URL inattendue ' + u); };
const call = (headers, body = '{}') => m.handler(new Request('http://f/gcal-sync', { method: 'POST', headers, body }));
ok((await call({})).status === 401, 'refus sans authentification');
ok((await call({ 'x-kayani-key': 'mauvaise' })).status === 401, 'refus clé interne erronée');
ok((await call({ authorization: 'Bearer jwt-pending' })).status === 403, 'refus compte non activé');
ok((await call({ 'x-goog-channel-token': 'sec', 'x-goog-channel-id': 'autre' })).status === 401, 'refus canal Google inconnu');
ok((await call({ 'x-goog-channel-token': 'sec', 'x-goog-channel-id': 'chan', 'x-goog-resource-state': 'sync' })).status === 200 && !assertion, 'ouverture de canal acquittée sans synchroniser');
const r = await call({ 'x-kayani-key': 'sec' }, JSON.stringify({ mode: 'all' })); const body = await r.json();
ok(r.status === 200 && body.caller === 'interne' && body.mode === 'all', 'synchronisation interne acceptée');
const [h, p, s] = assertion.split('.'); const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + p)), 'jeton Google correctement signé');
ok(pl.iss === 'sync@kayani.iam.gserviceaccount.com' && pl.scope.endsWith('/calendar.events') && pl.aud === 'https://oauth2.googleapis.com/token', 'contenu du jeton Google');
ok(watched && watched.address === 'http://db/functions/v1/gcal-sync' && watched.token === 'sec', 'canal de notification ouvert vers la fonction');
ok(state.sync_token === 'x' && upserts.some((u) => u.id === '_status' && u.device === 'google' && u.data.calendar === 'kayani.therapy@gmail.com'), 'jeton de synchro et statut enregistrés');
ok(!locked, 'verrou libéré');
const r2 = await call({ authorization: 'Bearer jwt-admin' }, JSON.stringify({ mode: 'pull' })); ok(r2.status === 200 && (await r2.json()).caller === 'admin', 'administrateur autorisé');
locked = true; const r3 = await call({ 'x-kayani-key': 'sec' }); ok(r3.status === 202, 'demande mise en attente si une synchronisation tourne déjà'); locked = false;
const pre = await call({}, ''); ok((await m.handler(new Request('http://f', { method: 'OPTIONS' }))).status === 200, 'pré-requête CORS');
console.log(fails ? `${fails} échec(s)` : 'Point d\'entrée : toutes les vérifications réussies.'); if (fails) process.exit(1);
