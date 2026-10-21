-- =====================================================================
--  KAYANI POS — schéma Supabase (à exécuter une fois, dans l'éditeur SQL)
--  Modèle « hors ligne d'abord » : chaque appareil garde ses données en
--  local et les synchronise ici. Chaque enregistrement est une ligne de la
--  table `records` (collection + id + contenu JSON), versionnée par `rev`.
--  Les droits (administrateur / assistante) sont appliqués par RLS.
-- =====================================================================

-- ---------- Profils utilisateurs ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  name       text not null default '',
  role       text not null default 'pending' check (role in ('admin','assistant','pending')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Création automatique du profil à l'inscription : rôle « pending » = aucun accès tant
-- que l'administrateur ne l'a pas activé (la clé anon étant publique, une inscription
-- spontanée ne doit donner accès à rien).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (
  id = auth.uid() or public.my_role() in ('admin','assistant'));
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- Enregistrements synchronisés ----------
create sequence if not exists public.records_rev_seq;
create table if not exists public.records (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null,
  deleted     boolean     not null default false,
  rev         bigint      not null default nextval('public.records_rev_seq'),
  device      text,
  updated_by  uuid        default auth.uid(),
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists records_rev_idx on public.records(rev);
alter table public.records enable row level security;

-- Chaque écriture reçoit un nouveau numéro de révision, l'auteur et l'heure du serveur
create or replace function public.records_touch() returns trigger
language plpgsql as $$
begin
  new.rev        := nextval('public.records_rev_seq');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

-- Collections visibles et modifiables par l'assistante (caisse, clients, agenda)
create or replace function public.assistant_can_read(c text) returns boolean
language sql immutable as $$
  select c = any (array['clients','sales','payments','bookings','memberships','advances',
                        'cash','cash_moves','services','products','stock_moves','settings','invoices'])
$$;
create or replace function public.assistant_can_write(c text) returns boolean
language sql immutable as $$
  select c = any (array['clients','sales','payments','bookings','memberships','advances',
                        'cash','cash_moves','stock_moves'])
$$;

drop policy if exists records_select on public.records;
create policy records_select on public.records for select to authenticated using (
  public.is_admin()
  or (public.my_role() = 'assistant' and public.assistant_can_read(collection))
);

drop policy if exists records_insert on public.records;
create policy records_insert on public.records for insert to authenticated with check (
  public.is_admin()
  or (collection = 'audit' and public.my_role() = 'assistant')
  or (public.my_role() = 'assistant' and public.assistant_can_write(collection))
);

-- Le journal d'audit est en insertion seule : aucune modification, même par l'administrateur
drop policy if exists records_update on public.records;
create policy records_update on public.records for update to authenticated using (
  collection <> 'audit' and (
    public.is_admin()
    or (public.my_role() = 'assistant' and public.assistant_can_write(collection))
  )
) with check (
  collection <> 'audit' and (
    public.is_admin()
    or (public.my_role() = 'assistant' and public.assistant_can_write(collection))
  )
);
-- Pas de politique DELETE : les suppressions passent par deleted = true.

-- ---------- Numérotation légale continue (factures et avoirs) ----------
create table if not exists public.doc_counters (
  prefix text not null,
  year   int  not null,
  last   int  not null default 0,
  primary key (prefix, year)
);
alter table public.doc_counters enable row level security;
-- aucune politique : accès uniquement via la fonction ci-dessous

create or replace function public.next_doc_number(p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare y int := extract(year from (now() at time zone 'Africa/Tunis'))::int; n int;
begin
  if coalesce(public.my_role(),'pending') not in ('admin','assistant') then raise exception 'Compte non activé'; end if;
  if p_prefix not in ('FAC','AV') then raise exception 'Préfixe non autorisé'; end if;
  if p_prefix = 'AV' and not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  insert into public.doc_counters(prefix, year, last) values (p_prefix, y, 1)
  on conflict (prefix, year) do update set last = doc_counters.last + 1
  returning last into n;
  return p_prefix || '-' || y || '-' || lpad(n::text, 5, '0');
end $$;
revoke all on function public.next_doc_number(text) from public, anon;
grant execute on function public.next_doc_number(text) to authenticated;

-- ---------- Promotion d'un compte en administrateur ----------
-- Usage, une fois le compte créé dans Authentication › Users :
--   select public.set_role('direction@exemple.tn', 'admin');
--   select public.set_role('accueil@exemple.tn', 'assistant');
create or replace function public.set_role(p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_role not in ('admin','assistant','pending') then raise exception 'Rôle inconnu'; end if;
  update public.profiles set role = p_role where lower(email) = lower(p_email);
  if not found then raise exception 'Aucun profil pour %', p_email; end if;
end $$;
revoke all on function public.set_role(text, text) from public, anon, authenticated;

-- ---------- Droits d'accès de l'application ----------
-- Nécessaire sur les projets Supabase qui n'ouvrent plus automatiquement les nouvelles tables à l'API.
grant usage on schema public to authenticated;
grant select, insert, update on public.records  to authenticated;
grant select, update         on public.profiles to authenticated;
grant usage, select on sequence public.records_rev_seq to authenticated;
grant execute on function public.my_role(), public.is_admin(),
  public.assistant_can_read(text), public.assistant_can_write(text),
  public.next_doc_number(text) to authenticated;
