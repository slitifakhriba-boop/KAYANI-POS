-- =====================================================================
--  KAYANI POS — version 3 : justificatifs (photos), clubs, équipe, crédits
--  À exécuter une seule fois dans Supabase › SQL Editor, après schema.sql
--  (et gcal.sql si la synchronisation Google a été installée).
--  Peut être relancé sans risque : aucune donnée existante n'est modifiée.
-- =====================================================================

-- ---------- 1. Espace privé « justificatifs » (photos et scans des factures) ----------
-- Privé : aucun lien public. L'application ouvre un fichier avec un lien signé valable 10 minutes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('justificatifs', 'justificatifs', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

-- L'administration lit, ajoute et remplace les justificatifs ; personne ne peut les supprimer
drop policy if exists justif_admin_read on storage.objects;
create policy justif_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'justificatifs' and public.is_admin());
drop policy if exists justif_admin_insert on storage.objects;
create policy justif_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'justificatifs' and public.is_admin());
drop policy if exists justif_admin_update on storage.objects;
create policy justif_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'justificatifs' and public.is_admin())
  with check (bucket_id = 'justificatifs' and public.is_admin());
-- L'assistante peut seulement déposer une photo (elle ne peut ni lister ni ouvrir les autres)
drop policy if exists justif_assist_insert on storage.objects;
create policy justif_assist_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'justificatifs' and public.my_role() = 'assistant');

-- ---------- 2. Collections visibles par l'assistante ----------
-- Ajout : « attendance » (feuilles de présence des clubs). Les collections « credits »
-- (crédits et engagements) et « team », « presence », « team_events » (équipe, paie)
-- restent réservées à l'administration : elles ne figurent dans aucune des deux listes.
create or replace function public.assistant_can_read(c text) returns boolean
language sql immutable as $$
  select c = any (array['clients','sales','payments','bookings','memberships','advances',
                        'cash','cash_moves','services','products','stock_moves','settings','invoices','gcal',
                        'attendance'])
$$;
create or replace function public.assistant_can_write(c text) returns boolean
language sql immutable as $$
  select c = any (array['clients','sales','payments','bookings','memberships','advances',
                        'cash','cash_moves','stock_moves','attendance'])
$$;
