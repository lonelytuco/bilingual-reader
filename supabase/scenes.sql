-- ============================================================
-- Картинки «где мы остановились». Запустить ОДИН раз:
-- Supabase → SQL Editor → New query → вставить весь файл → Run.
-- ============================================================

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  pair_id uuid not null references public.book_pairs on delete cascade,
  edition_id uuid references public.editions on delete set null,
  pos real not null,               -- место в книге, 0…1
  caption text,                    -- что происходит (1–2 предложения)
  image_path text,                 -- файл в хранилище scenes
  created_at timestamptz not null default now()
);

alter table public.scenes enable row level security;
drop policy if exists "own scenes" on public.scenes;
create policy "own scenes" on public.scenes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('scenes', 'scenes', false)
on conflict (id) do nothing;

drop policy if exists "own scene files read" on storage.objects;
create policy "own scene files read" on storage.objects
  for select using (bucket_id = 'scenes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own scene files insert" on storage.objects;
create policy "own scene files insert" on storage.objects
  for insert with check (bucket_id = 'scenes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own scene files delete" on storage.objects;
create policy "own scene files delete" on storage.objects
  for delete using (bucket_id = 'scenes' and (storage.foldername(name))[1] = auth.uid()::text);

-- (на всякий случай — колонка для Kindle, если ещё не добавлена)
alter table public.editions add column if not exists kindle_anchors jsonb;
