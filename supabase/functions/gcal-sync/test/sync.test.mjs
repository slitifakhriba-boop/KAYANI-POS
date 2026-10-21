// Tests du moteur de synchronisation avec un faux Google Agenda et une fausse base.
// Lancer : node supabase/functions/gcal-sync/test/sync.test.mjs
globalThis.__KAYANI_TEST__ = true;
const { makeEngine, parseTitle, sig } = await import('../index.ts');
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('ÉCHEC :', m); } };

function world() {
  let t = Date.parse('2026-10-22T08:00:00Z');
  const now = () => new Date(t); const tick = (min = 1) => { t += min * 60000; };
  // ---- fausse base ----
  const rec = new Map(); const state = { secret: 's', sync_token: null };
  const put = (c, id, data, deleted = false) => rec.set(c + '|' + id, { collection: c, id, data: structuredClone(data), deleted, updated_at: now().toISOString() });
  const db = {
    async getRecords(cols) { return [...rec.values()].filter((r) => cols.includes(r.collection)).map((r) => structuredClone(r)); },
    async upsertRecords(rows) { rows.forEach((r) => put(r.collection, r.id, r.data, r.deleted)); },
    async getState() { return { ...state }; }, async saveState(p) { Object.assign(state, p); },
  };
  // ---- faux Google ----
  const ev = new Map(); let seq = 0, nid = 0; const changed = new Map(); const calls = { insert: 0, patch: 0, remove: 0 };
  const touch = (e) => { e.updated = now().toISOString(); changed.set(e.id, ++seq); };
  const iso = (d, m) => `${d}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+01:00`;
  const norm = (x) => ({ dateTime: x.dateTime.length === 19 ? x.dateTime + '+01:00' : x.dateTime });
  const gcal = {
    async insert(body) { calls.insert++; const e = { id: 'ev' + (++nid), status: 'confirmed', ...structuredClone(body), start: norm(body.start), end: norm(body.end) }; ev.set(e.id, e); touch(e); return e; },
    async patch(id, body) { calls.patch++; const e = ev.get(id); if (!e || e.status === 'cancelled') return null; Object.assign(e, structuredClone(body), { start: norm(body.start), end: norm(body.end) }); touch(e); return e; },
    async remove(id) { calls.remove++; const e = ev.get(id); if (e) { e.status = 'cancelled'; touch(e); } },
    async list(q) { const since = q.syncToken ? Number(q.syncToken) : -1; const items = [...ev.values()].filter((e) => (changed.get(e.id) || 0) > since && (q.syncToken || e.status !== 'cancelled')).map((e) => structuredClone(e)); return { items, nextSyncToken: String(seq) }; },
    async findByKayaniId(k) { return [...ev.values()].find((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.kayaniId === k) || null; },
    async watch() { return { resourceId: 'r1', expiration: String(t + 6 * 864e5) }; }, async stop() {},
  };
  const user = {
    create(summary, d, m, dur) { const e = { id: 'u' + (++nid), status: 'confirmed', summary, start: { dateTime: iso(d, m) }, end: { dateTime: iso(d, m + dur) } }; ev.set(e.id, e); touch(e); return e; },
    move(id, d, m, dur) { const e = ev.get(id); e.start = { dateTime: iso(d, m) }; e.end = { dateTime: iso(d, m + dur) }; touch(e); },
    del(id) { const e = ev.get(id); e.status = 'cancelled'; touch(e); },
  };
  put('services', 'SC01', { id: 'SC01', name: 'Massage relaxant basique', type: 'Individuelle', dur: 60, staff: 'st1', room: 'Cabine 1', active: true, bookable: true });
  put('services', 'SC06', { id: 'SC06', name: 'Kobido', type: 'Individuelle', dur: 60, staff: 'st1', room: 'Cabine 2', active: true, bookable: true });
  put('services', 'CB03', { id: 'CB03', name: 'Cours de yoga', type: 'Collective', cap: 10, dur: 60, staff: 'st3', room: 'Salle', active: true, bookable: true });
  put('clients', 'CL1', { id: 'CL1', first: 'Amira', last: 'Ben Salah' });
  put('clients', 'CL2', { id: 'CL2', first: 'Sami', last: 'Gharbi' });
  const engine = makeEngine({ db, gcal, now, functionUrl: 'https://x/functions/v1/gcal-sync', calendar: 'kayani.therapy@gmail.com' });
  const B = (id) => rec.get('bookings|' + id)?.data; const L = (id) => rec.get('gcal|' + id)?.data;
  const app = { book(b) { tick(); put('bookings', b.id, { status: 'confirmé', size: 1, sync: 'demo', ...b }); }, edit(id, p) { tick(); put('bookings', id, { ...B(id), ...p }); } };
  return { engine, ev, calls, user, app, B, L, rec, tick, state };
}

// 1. Rendez-vous créé dans KAYANI → événement Google, sans renvoi inutile
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC06', staff: 'st1', room: 'Cabine 2', clientId: 'CL1' });
  await w.engine.run('all'); const e = [...w.ev.values()][0];
  ok(w.calls.insert === 1 && e.summary === 'Kobido — Amira Ben Salah', '1 création événement');
  ok(e.extendedProperties.private.kayaniId === 'R1' && e.start.dateTime.startsWith('2026-10-23T10:00'), '1 identifiant et horaire');
  ok(w.L('R1').eventId === e.id && w.L('R1').state === 'ok', '1 lien enregistré');
  w.tick(); await w.engine.run('all'); await w.engine.run('all');
  ok(w.calls.insert === 1 && w.calls.patch === 0, '1 aucune boucle ni doublon'); ok(w.B('R1').date === '2026-10-23', '1 rendez-vous intact');
  ok(w.rec.get('gcal|_status').data.calendar === 'kayani.therapy@gmail.com', '1 statut publié'); }

// 2. Déplacé puis annulé dans KAYANI
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC01', staff: 'st1', room: 'Cabine 1', clientId: 'CL2' }); await w.engine.run('all');
  w.app.edit('R1', { start: 720 }); await w.engine.run('push'); const e = [...w.ev.values()][0];
  ok(w.calls.patch === 1 && e.start.dateTime.includes('T12:00'), '2 déplacement envoyé');
  await w.engine.run('all'); ok(w.calls.patch === 1 && w.B('R1').start === 720, '2 pas de retour en boucle');
  w.app.edit('R1', { status: 'annulé' }); await w.engine.run('all');
  ok(e.status === 'cancelled' && w.L('R1').state === 'supprimé', '2 annulation supprime l\'événement');
  await w.engine.run('all'); ok(w.calls.remove === 1, '2 suppression une seule fois'); }

// 3. Rendez-vous créé dans Google avec un titre reconnu
{ const w = world(); w.user.create('Kobido — Amira Ben Salah', '2026-10-24', 840, 60);
  await w.engine.run('all'); const bs = [...w.rec.values()].filter((r) => r.collection === 'bookings');
  ok(bs.length === 1 && bs[0].data.serviceId === 'SC06' && bs[0].data.clientId === 'CL1' && bs[0].data.status === 'confirmé' && bs[0].data.start === 840 && bs[0].data.staff === 'st1', '3 rendez-vous créé et relié');
  await w.engine.run('all'); await w.engine.run('all');
  ok([...w.rec.values()].filter((r) => r.collection === 'bookings').length === 1 && w.calls.insert === 0 && w.calls.patch === 0, '3 pas de doublon ni renvoi'); }

// 4. Rendez-vous KAYANI déplacé dans Google → suivi dans KAYANI, sans boucle
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC01', staff: 'st1', room: 'Cabine 1', clientId: 'CL1' }); await w.engine.run('all');
  const e = [...w.ev.values()][0]; w.tick(); w.user.move(e.id, '2026-10-23', 900, 60);
  await w.engine.run('pull'); ok(w.B('R1').start === 900 && w.L('R1').state === 'ok', '4 horaire Google appliqué');
  const p = w.calls.patch; await w.engine.run('all'); ok(w.calls.patch === p, '4 pas de renvoi vers Google'); }

// 5. Déplacement Google en conflit → refusé, horaire KAYANI remis dans Google
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC01', staff: 'st1', room: 'Cabine 1', clientId: 'CL1' });
  w.app.book({ id: 'R2', date: '2026-10-23', start: 900, dur: 60, serviceId: 'SC06', staff: 'st1', room: 'Cabine 2', clientId: 'CL2' }); await w.engine.run('all');
  const e = [...w.ev.values()].find((x) => x.extendedProperties.private.kayaniId === 'R1'); w.tick(); w.user.move(e.id, '2026-10-23', 930, 60);
  await w.engine.run('pull');
  ok(w.B('R1').start === 600 && w.L('R1').state === 'conflit' && /occupé/.test(w.L('R1').message), '5 conflit détecté, horaire conservé');
  ok(e.start.dateTime.includes('T10:00'), '5 événement Google remis à l\'horaire KAYANI');
  const p = w.calls.patch; await w.engine.run('all'); await w.engine.run('all'); ok(w.calls.patch === p, '5 pas de boucle après conflit'); }

// 6. Supprimé dans Google → annulé dans KAYANI
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC01', staff: 'st1', room: 'Cabine 1', clientId: 'CL1' }); await w.engine.run('all');
  w.tick(); w.user.del([...w.ev.values()][0].id); await w.engine.run('all');
  ok(w.B('R1').status === 'annulé' && w.calls.insert === 1, '6 annulé sans recréation'); }

// 7. Titre non reconnu → « à relier », puis relié dans KAYANI → titre Google mis à jour
{ const w = world(); const u = w.user.create('Rendez-vous banque', '2026-10-24', 600, 30); await w.engine.run('all');
  const b = [...w.rec.values()].find((r) => r.collection === 'bookings').data;
  ok(b.status === 'externe' && w.L(b.id).state === 'à relier' && w.calls.patch === 0, '7 événement à relier, Google inchangé');
  w.app.edit(b.id, { serviceId: 'SC01', clientId: 'CL2', staff: 'st1', room: 'Cabine 1', status: 'confirmé', title: '' }); await w.engine.run('all');
  ok(u.summary === 'Massage relaxant basique — Sami Gharbi' && u.extendedProperties.private.kayaniId === b.id && w.calls.insert === 0, '7 relié et renvoyé'); }

// 8. Reprise après coupure : l'événement existe déjà dans Google, pas de doublon
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC01', staff: 'st1', room: 'Cabine 1', clientId: 'CL1' }); await w.engine.run('all');
  w.rec.delete('gcal|R1'); w.app.edit('R1', { start: 660 }); await w.engine.run('push');
  ok(w.calls.insert === 1 && [...w.ev.values()].filter((e) => e.status !== 'cancelled').length === 1 && w.L('R1').eventId, '8 aucun doublon après perte du lien'); }

// 9. Modifié des deux côtés : la modification la plus récente gagne
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 600, dur: 60, serviceId: 'SC01', staff: 'st1', room: 'Cabine 1', clientId: 'CL1' }); await w.engine.run('all');
  const e = [...w.ev.values()][0]; w.tick(); w.user.move(e.id, '2026-10-23', 780, 60); w.tick(); w.app.edit('R1', { start: 840 });
  await w.engine.run('all'); ok(w.B('R1').start === 840 && e.start.dateTime.includes('T14:00'), '9 KAYANI plus récent l\'emporte'); }

// 10. Séance collective et analyse des titres
{ const w = world(); w.app.book({ id: 'R1', date: '2026-10-23', start: 1080, dur: 60, serviceId: 'CB03', staff: 'st3', room: 'Salle', clientId: null, size: 6 }); await w.engine.run('all');
  ok([...w.ev.values()][0].summary === 'Cours de yoga (6/10 inscrits)', '10 titre séance collective');
  w.app.edit('R1', { size: 7 }); await w.engine.run('all'); ok([...w.ev.values()][0].summary === 'Cours de yoga (7/10 inscrits)', '10 inscrits mis à jour');
  const S = [{ id: 'a', name: 'Massage relaxant basique' }, { id: 'b', name: 'Kobido' }], C = [{ id: 'c', first: 'Amira', last: 'Ben Salah' }];
  ok(parseTitle('kobido - amira ben salah', S, C).client?.id === 'c' && parseTitle('Massage relaxant – Ben Salah Amira', S, C).service?.id === 'a', '10 titres tolérants (casse, tirets, ordre)');
  ok(parseTitle('Réunion équipe', S, C).service === null, '10 titre inconnu non relié'); }

// 11. Événement sur la journée entière : ignoré
{ const w = world(); const e = w.user.create('Congé', '2026-10-25', 0, 60); delete e.start.dateTime; e.start.date = '2026-10-25'; delete e.end.dateTime; e.end.date = '2026-10-26';
  await w.engine.run('all'); ok(![...w.rec.values()].some((r) => r.collection === 'bookings'), '11 journée entière ignorée'); }

console.log(`${passes} vérifications réussies, ${fails} échec(s).`); if (fails) process.exit(1);
