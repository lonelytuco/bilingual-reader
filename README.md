# Две книги — двуязычная читалка EPUB

Одна книга на двух языках. Позиция синхронизируется между iPad и MacBook,
можно перейти из Kindle по номеру позиции (Loc) или по фразе.

## Как устроено
- `src/app/page.tsx` — вход и библиотека
- `src/components/Library.tsx` — список книг и загрузка двух EPUB
- `src/components/Reader.tsx` — читалка (epub.js), Kindle, поиск, переключение языка
- `supabase/schema.sql` — таблицы и правила доступа (запустить один раз в Supabase → SQL Editor)

## Настройка
1. Supabase → SQL Editor → вставить `supabase/schema.sql` → Run.
2. Supabase → Authentication → URL Configuration → Site URL = адрес сайта на Vercel.
3. Vercel → Import этого репозитория → Deploy.

## Переход по выделенному тексту в другую версию
Выдели текст → «Найти в EN». Фрагмент переводится (по умолчанию бесплатный MyMemory, ~5000 знаков в день),
затем сайт ищет самое похожее место в другой версии рядом с той же позицией и открывает его с выделением.
Чтобы переводил Claude (лучше и без дневного лимита): Vercel → Settings → Environment Variables →
`ANTHROPIC_API_KEY` = ключ с console.anthropic.com → Redeploy.
