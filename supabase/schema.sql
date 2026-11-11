-- ============================================================
-- Двуязычная читалка: схема базы.
-- Запустить ОДИН раз: Supabase → SQL Editor → New query →
-- вставить весь этот файл → Run.
-- ============================================================

-- Книга (пара из двух языковых версий)
create table if not exists public.book_pairs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

-- Конкретная версия книги на одном языке (один EPUB)
create table if not exists public.editions (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references public.book_pairs on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  lang text not null,
  file_path text not null,
  kindle_total_locs integer,
  locations text,            -- кэш разметки позиций, чтобы не считать заново на каждом устройстве
  created_at timestamptz not null default now()
);

-- Где ты остановился (одна строка на книгу)
create table if not exists public.progress (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  pair_id uuid not null references public.book_pairs on delete cascade,
  edition_id uuid references public.editions on delete cascade,
  cfi text,
  percent real,
  device text,
  updated_at timestamptz not null default now(),
  primary key (user_id, pair_id)
);

-- Доступ: каждый видит только свои строки
alter table public.book_pairs enable row level security;
alter table public.editions   enable row level security;
alter table public.progress   enable row level security;

drop policy if exists "own pairs" on public.book_pairs;
create policy "own pairs" on public.book_pairs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own editions" on public.editions;
create policy "own editions" on public.editions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own progress" on public.progress;
create policy "own progress" on public.progress
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Хранилище файлов EPUB (приватное)
insert into storage.buckets (id, name, public)
values ('books', 'books', false)
on conflict (id) do nothing;

-- Файлы лежат в папке books/<id пользователя>/... — доступ только владельцу
drop policy if exists "own book files read" on storage.objects;
create policy "own book files read" on storage.objects
  for select using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own book files insert" on storage.objects;
create policy "own book files insert" on storage.objects
  for insert with check (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own book files update" on storage.objects;
create policy "own book files update" on storage.objects
  for update using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own book files delete" on storage.objects;
create policy "own book files delete" on storage.objects
  for delete using (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);

-- Подстройка позиций Kindle (добавлено позже; безопасно запускать повторно)
alter table public.editions add column if not exists kindle_anchors jsonb;
