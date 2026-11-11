"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, type BookPair, type Edition, type Progress } from "@/lib/supabase";
import { useTheme } from "@/lib/theme";
import { ThemeSwitch } from "@/components/Reader";

type Row = BookPair & { editions: Edition[]; progress: Progress | null };

const LANGS = ["EN", "RU", "DE", "FR", "ES", "IT", "PT", "JA", "ZH"];

export default function Library({ email }: { email: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [theme] = useTheme();

  async function load() {
    const { data: pairs } = await supabase
      .from("book_pairs")
      .select("id,title,created_at, editions(id,pair_id,lang,file_path,kindle_total_locs)")
      .order("created_at", { ascending: false });
    const { data: prog } = await supabase.from("progress").select("*");
    setRows(
      (pairs ?? []).map((p) => ({
        ...(p as unknown as Row),
        progress: (prog ?? []).find((g) => g.pair_id === p.id) ?? null,
      }))
    );
  }
  useEffect(() => { load(); }, []);

  async function remove(row: Row) {
    if (!confirm(`Удалить «${row.title}»?`)) return;
    await supabase.storage.from("books").remove(row.editions.map((e) => e.file_path));
    await supabase.from("book_pairs").delete().eq("id", row.id);
    load();
  }

  return (
    <main className="mx-auto max-w-2xl px-5 pb-20 pt-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="serif text-3xl">Мои книги</h1>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span className="hidden sm:inline">{email}</span>
          <button className="underline" onClick={() => supabase.auth.signOut()}>Выйти</button>
        </div>
      </header>

      <div className="mb-6 flex items-center gap-3 text-sm">
        <span className="text-muted">Тема</span>
        <ThemeSwitch theme={theme} />
      </div>

      {!showNew && (
        <button className="btn-primary mb-6" onClick={() => setShowNew(true)}>+ Добавить книгу</button>
      )}
      {showNew && <NewPair onDone={() => { setShowNew(false); load(); }} />}

      {rows === null && <p className="text-muted">Загрузка…</p>}
      {rows?.length === 0 && !showNew && (
        <p className="text-muted">Пока пусто. Добавь книгу: EPUB на одном языке, вторую версию можно добавить позже.</p>
      )}
      <ul className="divide-y divide-line">
        {rows?.map((r) => {
          const pct = Math.round((r.progress?.percent ?? 0) * 100);
          const cur = r.editions.find((e) => e.id === r.progress?.edition_id);
          if (editing === r.id)
            return (
              <li key={r.id} className="py-4">
                <EditPair row={r} onDone={() => { setEditing(null); load(); }} />
              </li>
            );
          return (
            <li key={r.id} className="flex items-center gap-4 py-4">
              <Link href={`/read/${r.id}`} className="min-w-0 flex-1">
                <div className="serif truncate text-xl">{r.title}</div>
                <div className="mt-1 text-sm text-muted">
                  {r.editions.map((e) => e.lang).join(" · ")}
                  {r.progress && ` — ${pct}%${cur ? ` (${cur.lang})` : ""}${r.progress.device ? `, ${r.progress.device}` : ""}`}
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded bg-line">
                  <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
              </Link>
              <div className="flex shrink-0 flex-col items-end gap-1 text-sm sm:flex-row sm:gap-4">
                <button className="text-muted hover:text-ink" onClick={() => setEditing(r.id)}>Изменить</button>
                <button className="text-muted hover:text-accent" onClick={() => remove(r)}>Удалить</button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

/** Загрузить один EPUB как версию книги */
async function uploadEdition(pairId: string, lang: string, file: File) {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user!.id;
  const path = `${uid}/${pairId}/${lang.toLowerCase()}-${Date.now()}.epub`;
  const up = await supabase.storage.from("books").upload(path, file, { contentType: "application/epub+zip", upsert: true });
  if (up.error) throw up.error;
  const ins = await supabase.from("editions").insert({ pair_id: pairId, lang, file_path: path });
  if (ins.error) throw ins.error;
}

type Pick = { lang: string; file: File | null };

function Picker({ v, set, label, langs = LANGS }: { v: Pick; set: (x: Pick) => void; label: string; langs?: string[] }) {
  return (
    <div className="flex gap-2">
      <select className="input w-24" value={v.lang} onChange={(e) => set({ ...v, lang: e.target.value })}>
        {langs.map((l) => <option key={l}>{l}</option>)}
      </select>
      <label className="input flex cursor-pointer items-center truncate text-sm text-muted">
        <input type="file" accept=".epub,application/epub+zip" className="hidden"
          onChange={(e) => set({ ...v, file: e.target.files?.[0] ?? null })} />
        {v.file ? <span className="truncate text-ink">{v.file.name}</span> : label}
      </label>
    </div>
  );
}

function NewPair({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [a, setA] = useState<Pick>({ lang: "RU", file: null });
  const [b, setB] = useState<Pick>({ lang: "EN", file: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const picks = [a, b].filter((x) => x.file);
    if (!picks.length) return setErr("Выбери хотя бы один файл.");
    if (picks.length === 2 && a.lang === b.lang) return setErr("Языки должны отличаться.");
    setBusy(true); setErr(null);
    try {
      const first = picks[0].file!;
      const { data: pair, error } = await supabase
        .from("book_pairs").insert({ title: title.trim() || first.name.replace(/\.epub$/i, "") })
        .select().single();
      if (error) throw error;
      for (const p of picks) await uploadEdition(pair.id, p.lang, p.file!);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <form onSubmit={save} className="mb-8 space-y-3 rounded-xl border border-line bg-card/50 p-4">
      <input className="input" placeholder="Название (необязательно)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Picker v={a} set={setA} label="Выбрать EPUB" />
      <Picker v={b} set={setB} label="Вторая версия (можно добавить позже)" />
      {err && <p className="text-sm text-accent">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>{busy ? "Загружаю…" : "Сохранить"}</button>
        <button type="button" className="btn-ghost" onClick={onDone}>Отмена</button>
      </div>
    </form>
  );
}

/** Изменить книгу: название, добавить версию на другом языке, убрать лишнюю версию */
function EditPair({ row, onDone }: { row: Row; onDone: () => void }) {
  const free = LANGS.filter((l) => !row.editions.some((e) => e.lang === l));
  const [title, setTitle] = useState(row.title);
  const [add, setAdd] = useState<Pick>({ lang: free[0] ?? "EN", file: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const t = title.trim();
      if (t && t !== row.title) {
        const { error } = await supabase.from("book_pairs").update({ title: t }).eq("id", row.id);
        if (error) throw error;
      }
      if (add.file) {
        if (row.editions.some((x) => x.lang === add.lang)) throw new Error(`Версия ${add.lang} уже есть.`);
        await uploadEdition(row.id, add.lang, add.file);
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  async function removeEdition(ed: Edition) {
    if (!confirm(`Убрать версию ${ed.lang} из «${row.title}»?`)) return;
    setBusy(true);
    await supabase.storage.from("books").remove([ed.file_path]);
    await supabase.from("editions").delete().eq("id", ed.id);
    setBusy(false);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded-xl border border-line bg-card/50 p-4">
      <label className="block text-sm text-muted">Название
        <input className="input mt-1" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <div className="text-sm">
        <div className="mb-1 text-muted">Версии</div>
        <div className="flex flex-wrap gap-2">
          {row.editions.map((ed) => (
            <span key={ed.id} className="inline-flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-1">
              {ed.lang}
              {row.editions.length > 1 && (
                <button type="button" className="text-muted hover:text-accent" title="Убрать версию" onClick={() => removeEdition(ed)}>✕</button>
              )}
            </span>
          ))}
        </div>
      </div>
      {free.length > 0 && (
        <div className="text-sm">
          <div className="mb-1 text-muted">Добавить версию на другом языке</div>
          <Picker v={add} set={setAdd} label="Выбрать EPUB" langs={free} />
        </div>
      )}
      {err && <p className="text-sm text-accent">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>{busy ? "Сохраняю…" : "Сохранить"}</button>
        <button type="button" className="btn-ghost" onClick={onDone}>Отмена</button>
      </div>
    </form>
  );
}
