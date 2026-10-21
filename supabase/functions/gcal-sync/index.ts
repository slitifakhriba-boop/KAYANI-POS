// @ts-nocheck — code JavaScript simple, sans annotations de type
// =====================================================================
//  KAYANI POS — synchronisation Google Agenda (Supabase Edge Function « gcal-sync »)
//
//  KAYANI → Google : chaque rendez-vous créé, déplacé ou annulé dans l'application
//  est envoyé dans l'agenda Google (déclencheur base de données + vérification
//  chaque minute).
//  Google → KAYANI : Google prévient la fonction dès qu'un événement change
//  (notifications push) ; les changements sont lus par synchronisation
//  incrémentale (syncToken) et écrits dans la table `records`.
//
//  Règles :
//  - Chaque rendez-vous garde l'identifiant de son événement Google (collection
//    « gcal » de `records`) et chaque événement créé par KAYANI porte l'identifiant
//    KAYANI (extendedProperties.private.kayaniId) : pas de doublon, pas de boucle.
//  - Une empreinte (date, heure, durée, prestation, cliente, statut, intervenant,
//    salle, inscrits) évite de renvoyer ce qui n'a pas changé.
//  - Si un horaire est modifié des deux côtés, la modification la plus récente
//    l'emporte. Un horaire déplacé dans Google qui crée un conflit (intervenant,
//    salle ou cliente déjà occupés) est refusé : le rendez-vous garde son horaire
//    KAYANI, l'événement Google est remis à cet horaire et le conflit est signalé.
//  - Un événement créé directement dans Google avec un titre « Prestation — Cliente »
//    devient un rendez-vous KAYANI. Sinon, il apparaît « à relier » dans l'agenda.
//
//  Secrets (Supabase › Edge Functions › Secrets) :
//    GOOGLE_SERVICE_ACCOUNT  contenu complet du fichier JSON de la clé du compte de service
//    GCAL_CALENDAR_ID        adresse de l'agenda partagé (kayani.therapy@gmail.com)
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY : fournis automatiquement par Supabase
//    (KAYANI_SERVICE_KEY peut remplacer SUPABASE_SERVICE_ROLE_KEY si besoin)
//  Déployer avec « Verify JWT » désactivé : la fonction vérifie elle-même chaque appel
//  (clé interne, jeton du canal Google ou session d'un utilisateur actif).
// =====================================================================

const TZ = 'Africa/Tunis';
const WINDOW_PAST_DAYS = 7;      // rendez-vous passés encore envoyés vers Google
const PULL_PAST_DAYS = 30;       // première lecture de l'agenda Google
const STAFF_NAMES = { st1: 'Praticienne', st2: 'Thérapeute', st3: 'Animateurs' };

// ---------- Outils ----------
export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function localParts(instant) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')) };
}
export const todayTunis = (now) => localParts(now).date;
const overlap = (a, ad, b, bd) => a < b + bd && b < a + ad;

// Empreinte d'un rendez-vous : ce qui doit être reflété dans Google
export const sig = (b) => [b.date, b.start, b.dur, b.serviceId || '', b.clientId || '', b.status || '', b.staff || '', b.room || '', b.size || 0, b.title || ''].join('|');

// « Kobido — Amira Ben Salah » → prestation et cliente reconnues
export function parseTitle(title, services, clients) {
  const t = String(title || '').trim();
  const m = t.split(/\s+[—–\-:|]\s+/);
  const left = norm(m[0]), right = norm(m.slice(1).join(' '));
  const active = services.filter((s) => s.active !== false && s.bookable !== false);
  let service = active.find((s) => norm(s.name) === left) || null;
  if (!service && left.length >= 4) {
    const c = active.filter((s) => norm(s.name).includes(left) || left.includes(norm(s.name)));
    service = c.sort((a, b) => b.name.length - a.name.length)[0] || null;
  }
  let client = null;
  if (right) client = clients.find((c) => norm(c.first + ' ' + c.last) === right || norm(c.last + ' ' + c.first) === right) || null;
  return { service, client };
}

export function bookingToEvent(b, ctx) {
  const s = b.serviceId ? ctx.services.get(b.serviceId) : null;
  const c = b.clientId ? ctx.clients.get(b.clientId) : null;
  const cname = c ? `${c.first} ${c.last}` : '';
  const collective = s && s.type === 'Collective';
  const summary = s
    ? (collective ? `${s.name} (${b.size || 0}${s.cap ? '/' + s.cap : ''} inscrits)` : `${s.name}${cname ? ' — ' + cname : ''}`)
    : (b.title || 'Rendez-vous KAYANI');
  const statusTxt = { 'confirmé': 'Confirmé', 'honoré': 'Honoré', 'absent': 'Absence', 'annulé': 'Annulé' }[b.status] || b.status;
  const lines = ['Réservé dans KAYANI POS.', `Intervenant : ${STAFF_NAMES[b.staff] || b.staff || '—'}`];
  if (b.room) lines.push(`Salle : ${b.room}`);
  lines.push(`Statut : ${statusTxt}`);
  const end = b.start + b.dur;
  return {
    summary: (b.status === 'absent' ? '[Absence] ' : '') + summary,
    description: lines.join('\n'),
    start: { dateTime: `${b.date}T${hm(b.start)}:00`, timeZone: TZ },
    end: { dateTime: `${end >= 1440 ? addDays(b.date, 1) : b.date}T${hm(end % 1440)}:00`, timeZone: TZ },
    extendedProperties: { private: { kayaniId: b.id } },
  };
}

export function eventTimes(ev) {
  if (!ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return null; // journée entière : ignorée
  const a = localParts(ev.start.dateTime), z = localParts(ev.end.dateTime);
  const dur = Math.round((new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 60000);
  if (dur <= 0) return null;
  return { date: a.date, start: a.min, dur, endDate: z.date };
}

// Conflit côté serveur (mêmes règles que l'application : intervenant, salle, cliente)
export function serverConflict(b, bookings, ctx) {
  const same = bookings.filter((x) => x.id !== b.id && x.date === b.date && x.status !== 'annulé' && overlap(b.start, b.dur, x.start, x.dur));
  const st = b.staff && same.find((x) => x.staff === b.staff);
  if (st) return `${STAFF_NAMES[b.staff] || b.staff} est déjà occupé·e de ${hm(st.start)} à ${hm(st.start + st.dur)}.`;
  const rm = b.room && same.find((x) => x.room === b.room);
  if (rm) return `La salle « ${b.room} » est déjà réservée de ${hm(rm.start)} à ${hm(rm.start + rm.dur)}.`;
  const cl = b.clientId && same.find((x) => x.clientId === b.clientId);
  if (cl) { const c = ctx.clients.get(b.clientId); return `${c ? c.first + ' ' + c.last : 'La cliente'} a déjà un rendez-vous à ${hm(cl.start)}.`; }
  return null;
}

const shortId = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// =====================================================================
//  Moteur de synchronisation (indépendant de Supabase et de Google : testable)
//  db   : getRecords(collections) · upsertRecords(rows) · getState() · saveState(patch)
//  gcal : insert(ev) · patch(id, ev) · remove(id) · list(params) · findByKayaniId(id) · watch(o) · stop(o)
// =====================================================================
export function makeEngine({ db, gcal, now = () => new Date(), functionUrl = '', calendar = '' }) {
  async function load() {
    const rows = await db.getRecords(['bookings', 'services', 'clients', 'gcal']);
    const ctx = { services: new Map(), clients: new Map(), bookings: new Map(), updatedAt: new Map(), deleted: new Set(), links: new Map(), byEvent: new Map(), status: null };
    for (const r of rows) {
      if (r.collection === 'services' && !r.deleted) ctx.services.set(r.id, r.data);
      else if (r.collection === 'clients' && !r.deleted) ctx.clients.set(r.id, r.data);
      else if (r.collection === 'bookings') { ctx.bookings.set(r.id, r.data); ctx.updatedAt.set(r.id, r.updated_at); if (r.deleted) ctx.deleted.add(r.id); }
      else if (r.collection === 'gcal') { if (r.id === '_status') ctx.status = r.data; else { ctx.links.set(r.id, r.data); if (r.data.eventId) ctx.byEvent.set(r.data.eventId, r.data); } }
    }
    ctx.changedLinks = new Map(); ctx.changedBookings = new Map();
    return ctx;
  }
  const setLink = (ctx, l) => { l.at = now().toISOString(); ctx.links.set(l.id, l); if (l.eventId) ctx.byEvent.set(l.eventId, l); ctx.changedLinks.set(l.id, l); };
  const setBooking = (ctx, b) => { ctx.bookings.set(b.id, b); ctx.updatedAt.set(b.id, now().toISOString()); ctx.changedBookings.set(b.id, b); };
  async function flush(ctx) {
    const rows = [
      ...[...ctx.changedBookings.values()].map((b) => ({ collection: 'bookings', id: b.id, data: b, deleted: false })),
      ...[...ctx.changedLinks.values()].map((l) => ({ collection: 'gcal', id: l.id, data: l, deleted: false })),
    ];
    if (rows.length) await db.upsertRecords(rows);
    ctx.changedBookings.clear(); ctx.changedLinks.clear();
    return rows.length;
  }

  // ---------- KAYANI → Google ----------
  async function push(ctx) {
    const from = addDays(todayTunis(now()), -WINDOW_PAST_DAYS);
    let n = 0;
    for (const [id, b] of ctx.bookings) {
      let link = ctx.links.get(id);
      const isDeleted = ctx.deleted.has(id) || b.status === 'annulé';
      if (!link && (isDeleted || b.date < from)) continue;            // historique ou jamais envoyé
      if (link && link.origin === 'google' && b.status === 'externe') continue; // événement Google non relié : Google fait foi
      if (!b.serviceId && link?.origin !== 'google') continue;          // bloc d'indisponibilité local
      const s = sig(b) + (isDeleted ? '|x' : '');
      if (link && link.sig === s && link.state !== 'erreur') continue;
      try {
        if (isDeleted) {
          if (link?.eventId) { await gcal.remove(link.eventId); }
          setLink(ctx, { ...(link || { id }), sig: s, state: 'supprimé', message: '' }); n++; continue;
        }
        const body = bookingToEvent(b, ctx);
        let eventId = link?.eventId || null;
        if (eventId) {
          const r = await gcal.patch(eventId, body);
          if (r === null) eventId = null; // supprimé entre-temps dans Google : on le recrée
        }
        if (!eventId) {
          const found = await gcal.findByKayaniId(id);  // reprise après coupure : pas de doublon
          if (found) { await gcal.patch(found.id, body); eventId = found.id; }
          else { const ev = await gcal.insert(body); eventId = ev.id; }
        }
        const reverted = link?.sig === 'à renvoyer'; // horaire KAYANI remis dans Google après un conflit
        setLink(ctx, { ...(link || { id, origin: 'kayani' }), eventId, sig: s, state: reverted ? 'conflit' : 'ok', message: reverted ? link.message : '' }); n++;
      } catch (e) {
        setLink(ctx, { ...(link || { id, origin: 'kayani' }), sig: link?.sig || '', state: 'erreur', message: String(e.message || e).slice(0, 300) });
      }
    }
    return n;
  }

  // ---------- Google → KAYANI ----------
  async function pull(ctx) {
    const st = await db.getState();
    let token = st.sync_token || null, pageToken = null, nextSync = null, n = 0;
    const base = { singleEvents: true, showDeleted: true, maxResults: 250 };
    for (;;) {
      let res;
      try {
        res = await gcal.list(token ? { ...base, syncToken: token, pageToken } : { ...base, timeMin: new Date(now().getTime() - PULL_PAST_DAYS * 864e5).toISOString(), pageToken });
      } catch (e) {
        if (e.status === 410 && token) { token = null; pageToken = null; continue; } // jeton expiré : relecture complète
        throw e;
      }
      for (const ev of res.items || []) n += applyEvent(ctx, ev) ? 1 : 0;
      if (res.nextPageToken) { pageToken = res.nextPageToken; continue; }
      nextSync = res.nextSyncToken || null; break;
    }
    await db.saveState({ sync_token: nextSync, last_pull_at: now().toISOString() });
    return n;
  }

  function applyEvent(ctx, ev) {
    const kid = ev.extendedProperties?.private?.kayaniId;
    const link = (kid && ctx.links.get(kid)) || ctx.byEvent.get(ev.id) || null;
    const bid = link ? link.id : kid || null;
    const b = bid ? ctx.bookings.get(bid) : null;

    if (ev.status === 'cancelled') {
      if (!link || link.state === 'supprimé') return false;
      if (b && !ctx.deleted.has(bid) && b.status !== 'annulé') {
        if (b.status === 'confirmé' || b.status === 'externe') {
          setBooking(ctx, { ...b, status: 'annulé', cancelledFrom: 'google' });
          setLink(ctx, { ...link, sig: sig({ ...b, status: 'annulé' }) + '|x', state: 'supprimé', message: 'Supprimé dans Google Agenda' });
          return true;
        }
        setLink(ctx, { ...link, state: 'supprimé', message: 'Supprimé dans Google Agenda (rendez-vous déjà passé, conservé)' }); return true;
      }
      setLink(ctx, { ...link, state: 'supprimé' }); return true;
    }

    const t = eventTimes(ev);
    if (!t) return false;

    if (b) {
      // Événement Google non relié : on suit le titre et l'horaire de Google
      if (b.status === 'externe' && link?.origin === 'google') {
        const nb = { ...b, date: t.date, start: t.start, dur: t.dur, title: ev.summary || b.title };
        if (sig(nb) === sig(b)) return false;
        setBooking(ctx, nb); setLink(ctx, { ...link, sig: sig(nb), state: 'à relier' }); return true;
      }
      if (t.date === b.date && t.start === b.start && t.dur === b.dur) return false;
      if (ctx.deleted.has(bid) || b.status === 'annulé') return false; // sera supprimé par l'envoi
      // Modifié des deux côtés : la modification la plus récente gagne
      const appChanged = link && link.sig !== sig(b);
      const appAt = Date.parse(ctx.updatedAt.get(bid) || 0), evAt = Date.parse(ev.updated || 0);
      if (appChanged && appAt > evAt) return false; // l'envoi remettra l'horaire KAYANI dans Google
      const nb = { ...b, date: t.date, start: t.start, dur: t.dur };
      const conflict = serverConflict(nb, [...ctx.bookings.values()].filter((x) => !ctx.deleted.has(x.id)), ctx);
      if (conflict) {
        setLink(ctx, { ...(link || { id: bid, origin: 'kayani', eventId: ev.id }), sig: 'à renvoyer', state: 'conflit', message: `Déplacement refusé (${t.date.slice(8, 10)}/${t.date.slice(5, 7)} ${hm(t.start)}) : ${conflict} L'horaire KAYANI est conservé.` });
        return true;
      }
      setBooking(ctx, { ...nb, movedFrom: 'google' });
      setLink(ctx, { ...(link || { id: bid, origin: 'kayani', eventId: ev.id }), eventId: ev.id, sig: sig(nb), state: 'ok', message: '' });
      return true;
    }
    if (kid) return false; // rendez-vous KAYANI supprimé définitivement : ignoré

    // Nouvel événement créé dans Google
    const { service, client } = parseTitle(ev.summary, [...ctx.services.values()], [...ctx.clients.values()]);
    const id = 'G-' + shortId(ev.id) + ev.id.slice(-6).replace(/[^a-z0-9]/gi, '');
    const nb = service
      ? { id, date: t.date, start: t.start, dur: t.dur, serviceId: service.id, staff: service.staff || null, room: service.room || '', clientId: client ? client.id : null, status: 'confirmé', sync: 'google', size: 1, title: client ? '' : (ev.summary || ''), source: 'google' }
      : { id, date: t.date, start: t.start, dur: t.dur, serviceId: null, staff: null, room: '', clientId: null, status: 'externe', sync: 'google', size: 0, title: ev.summary || 'Événement Google', source: 'google' };
    setBooking(ctx, nb);
    setLink(ctx, { id, eventId: ev.id, origin: 'google', sig: sig(nb), state: service ? 'ok' : 'à relier', message: service && !client ? 'Cliente non reconnue dans le titre' : '' });
    return true;
  }

  // ---------- Notifications push de Google ----------
  async function ensureWatch(force = false) {
    if (!functionUrl) return null;
    const st = await db.getState();
    const exp = st.channel_expires ? Date.parse(st.channel_expires) : 0;
    if (!force && exp - now().getTime() > 24 * 3600e3) return st.channel_expires;
    if (st.channel_id && st.resource_id) { try { await gcal.stop({ id: st.channel_id, resourceId: st.resource_id }); } catch (_) { /* déjà expiré */ } }
    const id = crypto.randomUUID();
    const r = await gcal.watch({ id, type: 'web_hook', address: functionUrl, token: st.secret, params: { ttl: '604800' } });
    const expires = new Date(Number(r.expiration) || now().getTime() + 6 * 864e5).toISOString();
    await db.saveState({ channel_id: id, resource_id: r.resourceId, channel_expires: expires });
    return expires;
  }

  async function run(mode = 'all') {
    const ctx = await load();
    const out = { pushed: 0, pulled: 0, watch: null, error: '' };
    try {
      if (mode === 'pull' || mode === 'all') out.pulled = await pull(ctx);
      if (mode === 'push' || mode === 'all' || out.pulled) out.pushed = await push(ctx); // un conflit tiré de Google est renvoyé tout de suite
    } catch (e) { out.error = String(e.message || e).slice(0, 300); }
    if (mode === 'all') { try { out.watch = await ensureWatch(); } catch (e) { out.watchError = String(e.message || e).slice(0, 200); } }
    const prev = ctx.status || {};
    const errors = [...ctx.links.values()].filter((l) => l.state === 'erreur').length;
    const conflicts = [...ctx.links.values()].filter((l) => l.state === 'conflit').length;
    const nowIso = now().toISOString();
    const status = { id: '_status', active: true, calendar: calendar || prev.calendar || '', lastRun: nowIso, lastChange: (out.pushed || out.pulled) ? nowIso : (prev.lastChange || ''), error: out.error, watchUntil: out.watch || prev.watchUntil || '', watchError: out.watchError || '', errors, conflicts };
    const stale = !prev.lastRun || Date.parse(nowIso) - Date.parse(prev.lastRun) > 10 * 60e3;
    if (stale || out.pushed || out.pulled || status.error !== (prev.error || '') || status.errors !== prev.errors || status.conflicts !== prev.conflicts || status.watchUntil !== prev.watchUntil || status.watchError !== (prev.watchError || '')) {
      ctx.changedLinks.set('_status', status);
    }
    await flush(ctx);
    return out;
  }
  return { run, load, push, pull, ensureWatch };
}

// =====================================================================
//  Adaptateurs réels : Supabase (REST, clé de service) et Google Calendar API
// =====================================================================
const env = (k) => (globalThis.Deno ? Deno.env.get(k) : (globalThis.process?.env?.[k])) || '';

function supabaseDb(url, key) {
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rest = async (path, init = {}) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...h, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`Supabase ${r.status} : ${(await r.text()).slice(0, 200)}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };
  return {
    rest,
    async getRecords(cols) {
      const out = [];
      for (let off = 0; ; off += 1000) {
        const page = await rest(`records?select=collection,id,data,deleted,updated_at&collection=in.(${cols.join(',')})&order=collection,id&limit=1000&offset=${off}`);
        out.push(...page); if (page.length < 1000) break;
      }
      return out;
    },
    async upsertRecords(rows) {
      for (let i = 0; i < rows.length; i += 200) {
        await rest('records?on_conflict=collection,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 200).map((r) => ({ ...r, device: 'google' }))) });
      }
    },
    async getState() { const r = await rest('gcal_state?id=eq.1&select=*'); return r[0] || {}; },
    async saveState(p) { await rest('gcal_state?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(p) }); },
    async tryLock(sec) { return await rest('rpc/gcal_try_lock', { method: 'POST', body: JSON.stringify({ p_seconds: sec }) }); },
    async unlock() { return await rest('rpc/gcal_unlock', { method: 'POST', body: '{}' }); },
    async requestAgain() { await rest('rpc/gcal_request_again', { method: 'POST', body: '{}' }); },
  };
}

function b64url(bytes) { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const enc = (o) => b64url(new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o)));
let tokenCache = { value: '', exp: 0 };
async function googleToken(sa) {
  if (tokenCache.value && tokenCache.exp > Date.now() + 60e3) return tokenCache.value;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
  const sig_ = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig_) }) });
  const j = await r.json(); if (!r.ok) throw new Error('Connexion Google refusée : ' + (j.error_description || j.error || r.status));
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return j.access_token;
}

function googleCalendar(sa, calendarId) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`;
  const call = async (method, path, body, query) => {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)])) : '';
    const r = await fetch(path.startsWith('http') ? path + qs : base + path + qs, { method, headers: { Authorization: `Bearer ${await googleToken(sa)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return {};
    const t = await r.text(); const j = t ? JSON.parse(t) : {};
    if (!r.ok) { const e = new Error(`Google ${r.status} : ${j.error?.message || t.slice(0, 200)}`); e.status = r.status; throw e; }
    return j;
  };
  return {
    insert: (ev) => call('POST', '/events', ev),
    async patch(id, ev) { try { return await call('PATCH', `/events/${encodeURIComponent(id)}`, ev); } catch (e) { if (e.status === 404 || e.status === 410) return null; throw e; } },
    async remove(id) { try { await call('DELETE', `/events/${encodeURIComponent(id)}`); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; } },
    list: (q) => call('GET', '/events', null, q),
    async findByKayaniId(kid) { const r = await call('GET', '/events', null, { privateExtendedProperty: `kayaniId=${kid}`, showDeleted: false, maxResults: 1 }); return (r.items || [])[0] || null; },
    watch: (o) => call('POST', '/events/watch', o),
    stop: (o) => call('POST', 'https://www.googleapis.com/calendar/v3/channels/stop', o),
  };
}

// ---------- Point d'entrée HTTP ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = env('SUPABASE_URL'), key = env('KAYANI_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  const calendarId = env('GCAL_CALENDAR_ID'); let sa = null;
  try { sa = JSON.parse(env('GOOGLE_SERVICE_ACCOUNT') || 'null'); } catch (_) { sa = null; }
  if (!url || !key) return json({ error: 'Clé de service Supabase absente.' }, 500);
  const db = supabaseDb(url, key);
  const st = await db.getState();
  if (!st.secret) return json({ error: 'Migration gcal.sql non installée.' }, 500);

  // Authentification : appel interne (déclencheur ou cron), notification Google, ou utilisateur actif
  const goog = req.headers.get('x-goog-channel-token');
  let caller = '';
  if (req.headers.get('x-kayani-key') === st.secret) caller = 'interne';
  else if (goog) { if (goog !== st.secret || req.headers.get('x-goog-channel-id') !== st.channel_id) return json({ error: 'Canal inconnu' }, 401); caller = 'google'; }
  else {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const u = jwt ? await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${jwt}` } }) : null;
    if (!u || !u.ok) return json({ error: 'Non autorisé' }, 401);
    const me = await u.json();
    const prof = await db.rest(`profiles?id=eq.${me.id}&select=role`);
    if (!prof[0] || !['admin', 'assistant'].includes(prof[0].role)) return json({ error: 'Compte non activé' }, 403);
    caller = prof[0].role;
  }
  if (caller === 'google' && req.headers.get('x-goog-resource-state') === 'sync') return json({ ok: true }); // message d'ouverture du canal

  if (!sa || !sa.private_key || !calendarId) {
    await db.upsertRecords([{ collection: 'gcal', id: '_status', data: { id: '_status', active: false, error: 'Secrets GOOGLE_SERVICE_ACCOUNT ou GCAL_CALENDAR_ID manquants.', lastRun: new Date().toISOString() }, deleted: false }]);
    return json({ error: 'Secrets Google manquants.' }, 500);
  }
  let mode = 'all';
  if (caller === 'google') mode = 'pull';
  else { try { const b = await req.json(); if (['push', 'pull', 'all', 'rewatch'].includes(b?.mode)) mode = b.mode; } catch (_) { /* corps vide */ } }

  if (!(await db.tryLock(55))) { await db.requestAgain(); return json({ ok: true, queued: true }, 202); }
  const engine = makeEngine({ db, gcal: googleCalendar(sa, calendarId), functionUrl: `${url}/functions/v1/gcal-sync`, calendar: calendarId });
  const results = [];
  try {
    if (mode === 'rewatch') { results.push({ watch: await engine.ensureWatch(true) }); mode = 'all'; }
    results.push(await engine.run(mode));
    for (let i = 0; i < 3 && (await db.unlock()); i++) { if (!(await db.tryLock(55))) break; results.push(await engine.run('all')); } // demandes reçues pendant l'exécution
  } finally { await db.unlock(); }
  return json({ ok: true, caller, mode, results });
}

if (globalThis.Deno && typeof Deno.serve === 'function' && !globalThis.__KAYANI_TEST__) Deno.serve(handler);
