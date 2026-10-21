-- =====================================================================
--  KAYANI POS — synchronisation Google Agenda
--  À exécuter une seule fois dans Supabase › SQL Editor, après schema.sql.
--  Peut être relancé sans risque (aucune donnée existante n'est modifiée).
--
--  - gcal_state : état privé de la synchronisation (jeton Google, canal de
--    notification, verrou, clé interne). Aucun accès depuis l'application.
--  - Un déclencheur prévient la fonction gcal-sync dès qu'un rendez-vous est
--    créé ou modifié dans KAYANI.
--  - Une tâche planifiée relance une synchronisation complète chaque minute
--    (filet de sécurité si une notification se perd).
--  - L'état de chaque rendez-vous vis-à-vis de Google est publié dans la
--    collection « gcal » de records (lecture seule pour l'application).
-- =====================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------- État privé ----------
create table if not exists public.gcal_state (
  id              int primary key default 1 check (id = 1),
  secret          text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  function_url    text not null default 'https://xgarbvcmzopxpafpekhk.supabase.co/functions/v1/gcal-sync',
  sync_token      text,
  channel_id      text,
  resource_id     text,
  channel_expires timestamptz,
  lock_until      timestamptz,
  again           boolean not null default false,
  last_pull_at    timestamptz
);
insert into public.gcal_state(id) values (1) on conflict (id) do nothing;
alter table public.gcal_state enable row level security;
-- aucune politique : invisible pour l'application (clé anon et comptes connectés)
revoke all on public.gcal_state from anon, authenticated;

-- ---------- Verrou : une seule synchronisation à la fois ----------
create or replace function public.gcal_try_lock(p_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.gcal_state set lock_until = now() + make_interval(secs => p_seconds), again = false
   where id = 1 and (lock_until is null or lock_until < now());
  return found;
end $$;

-- Libère le verrou et indique si une demande est arrivée pendant l'exécution
create or replace function public.gcal_unlock() returns boolean
language plpgsql security definer set search_path = public as $$
declare a boolean;
begin
  update public.gcal_state set lock_until = null where id = 1 returning again into a;
  return coalesce(a, false);
end $$;

create or replace function public.gcal_request_again() returns void
language sql security definer set search_path = public as $$
  update public.gcal_state set again = true where id = 1
$$;

-- ---------- Appel de la fonction gcal-sync ----------
create or replace function public.gcal_kick(p_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select secret, function_url into s from public.gcal_state where id = 1;
  if s.secret is null then return; end if;
  perform net.http_post(
    url := s.function_url,
    body := jsonb_build_object('mode', p_mode),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kayani-key', s.secret),
    timeout_milliseconds := 60000);
end $$;

-- Un rendez-vous créé ou modifié dans KAYANI : envoi immédiat vers Google.
-- Les écritures faites par la synchronisation elle-même (device = 'google') ne relancent rien.
create or replace function public.gcal_on_records() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from new_rows where collection = 'bookings' and coalesce(device, '') <> 'google') then
    perform public.gcal_kick('push');
  end if;
  return null;
end $$;
drop trigger if exists gcal_on_records_ins on public.records;
create trigger gcal_on_records_ins after insert on public.records
  referencing new table as new_rows for each statement execute function public.gcal_on_records();
drop trigger if exists gcal_on_records_upd on public.records;
create trigger gcal_on_records_upd after update on public.records
  referencing new table as new_rows for each statement execute function public.gcal_on_records();

-- ---------- Vérification complète chaque minute ----------
do $$ begin perform cron.unschedule('kayani-gcal-sync'); exception when others then null; end $$;
select cron.schedule('kayani-gcal-sync', '* * * * *', $$select public.gcal_kick('all')$$);

-- ---------- Droits ----------
revoke all on function public.gcal_try_lock(int), public.gcal_unlock(), public.gcal_request_again(), public.gcal_kick(text) from public, anon, authenticated;
grant execute on function public.gcal_try_lock(int), public.gcal_unlock(), public.gcal_request_again() to service_role;
grant select, update on public.gcal_state to service_role;
grant select, insert, update on public.records to service_role;
grant usage, select on sequence public.records_rev_seq to service_role;
grant select on public.profiles to service_role;

-- L'assistante voit l'état de synchronisation des rendez-vous (lecture seule)
create or replace function public.assistant_can_read(c text) returns boolean
language sql immutable as $$
  select c = any (array['clients','sales','payments','bookings','memberships','advances',
                        'cash','cash_moves','services','products','stock_moves','settings','invoices','gcal'])
$$;

-- Pour arrêter la synchronisation :
--   select cron.unschedule('kayani-gcal-sync');
--   drop trigger gcal_on_records_ins on public.records; drop trigger gcal_on_records_upd on public.records;
