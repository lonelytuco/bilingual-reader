"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, type BookPair, type Edition, type Progress } from "@/lib/supabase";

type Row = BookPair & { editions: Edition[]; progress: Progress | null };

const LANGS = ["EN", "RU", "DE", "FR", "ES", "IT", "PT", "JA", "ZH"];

export default function Library({ email }: { email: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [showNew, setShowNew] = useState(false);

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

      {!showNew && (
        <button className="btn-primary mb-6" onClick={() => setShowNew(true)}>+ Добавить книгу</button>
      )}
      {showNew && <NewPair onDone={() => { setShowNew(false); load(); }} />}

      {rows === null && <p className="text-muted">Загрузка…</p>}
      {rows?.length === 0 && !showNew && (
        <p className="text-muted">Пока пусто. Добавь книгу: два EPUB-файла одной книги на разных языках.</p>
      )}
      <ul className="divide-y divide-line">
        {rows?.map((r) => {
          const pct = Math.round((r.progress?.percent ?? 0) * 100);
          const cur = r.editions.find((e) => e.id === r.progress?.edition_id);
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
              <button className="text-sm text-muted hover:text-accent" onClick={() => remove(r)}>Удалить</button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function NewPair({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [a, setA] = useState<{ lang: string; file: File | null }>({ lang: "EN", file: null });
  const [b, setB] = useState<{ lang: string; file: File | null }>({ lang: "RU", file: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!a.file || !b.file) return setErr("Выбери оба файла.");
    if (a.lang === b.lang) return setErr("Языки должны отличаться.");
    setBusy(true); setErr(null);
    try {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user!.id;
      const { data: pair, error } = await supabase
        .from("book_pairs").insert({ title: title || a.file.name.replace(/\.epub$/i, "") })
        .select().single();
      if (error) throw error;
      for (const ed of [a, b]) {
        const path = `${uid}/${pair.id}/${ed.lang.toLowerCase()}.epub`;
        const up = await supabase.storage.from("books")
          .upload(path, ed.file!, { contentType: "application/epub+zip", upsert: true });
        if (up.error) throw up.error;
        const ins = await supabase.from("editions").insert({ pair_id: pair.id, lang: ed.lang, file_path: path });
        if (ins.error) throw ins.error;
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  const Picker = ({ v, set, label }: { v: typeof a; set: (x: typeof a) => void; label: string }) => (
    <div className="flex gap-2">
      <select className="input w-24" value={v.lang} onChange={(e) => set({ ...v, lang: e.target.value })}>
        {LANGS.map((l) => <option key={l}>{l}</option>)}
      </select>
      <label className="input flex cursor-pointer items-center truncate text-sm text-muted">
        <input type="file" accept=".epub,application/epub+zip" className="hidden"
          onChange={(e) => set({ ...v, file: e.target.files?.[0] ?? null })} />
        {v.file ? <span className="truncate text-ink">{v.file.name}</span> : label}
      </label>
    </div>
  );

  return (
    <form onSubmit={save} className="mb-8 space-y-3 rounded-xl border border-line bg-white/50 p-4">
      <input className="input" placeholder="Название (необязательно)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Picker v={a} set={setA} label="Выбрать EPUB — версия 1" />
      <Picker v={b} set={setB} label="Выбрать EPUB — версия 2" />
      {err && <p className="text-sm text-accent">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>{busy ? "Загружаю…" : "Сохранить"}</button>
        <button type="button" className="btn-ghost" onClick={onDone}>Отмена</button>
      </div>
    </form>
  );
}
