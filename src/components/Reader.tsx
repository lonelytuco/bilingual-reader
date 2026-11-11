"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase, deviceName, type Edition, type Progress } from "@/lib/supabase";
import { useTheme, setTheme, THEMES, READER_COLORS } from "@/lib/theme";

type Jump = { cfi?: string; percent?: number } | null;

// Шрифты лежат в /public/fonts (латиница + кириллица), "book" — оставить шрифт издательства
export const FONTS: { id: string; name: string; css: string | null }[] = [
  { id: "literata", name: "Literata", css: "'Literata', Georgia, serif" },
  { id: "pt-serif", name: "PT Serif", css: "'PT Serif', Georgia, serif" },
  { id: "lora", name: "Lora", css: "'Lora', Georgia, serif" },
  { id: "georgia", name: "Georgia", css: "Georgia, 'Times New Roman', serif" },
  { id: "inter", name: "Inter (без засечек)", css: "'Inter', -apple-system, sans-serif" },
  { id: "system", name: "Системный (San Francisco)", css: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { id: "book", name: "Как в книге", css: null },
];

function themeCss(dark: boolean) {
  const c = dark ? READER_COLORS.dark : READER_COLORS.light;
  // В тёмной теме перекрашиваем весь текст (издательские цвета рассчитаны на белый фон)
  return dark
    ? `html, body { background: ${c.bg} !important; } body, body * { color: ${c.fg} !important; background-color: transparent !important; border-color: #3a3631 !important; } body a, body a * { color: ${c.link} !important; } img { opacity: .88; }`
    : `html, body { background: transparent !important; color: ${c.fg} !important; } body a { color: ${c.link} !important; }`;
}

function fontCss(id: string) {
  const f = FONTS.find((x) => x.id === id);
  return f?.css ? `body, body p, body div, body span, body li, body blockquote, body h1, body h2, body h3, body h4 { font-family: ${f.css} !important; }` : "";
}

export default function Reader({ pairId }: { pairId: string }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const rendRef = useRef<any>(null);
  const jumpRef = useRef<Jump>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>("");
  const me = useRef<string>("");
  const fontRef = useRef<string>("literata");
  const darkRef = useRef<boolean>(false);
  const [theme, dark] = useTheme();
  darkRef.current = dark;

  const [title, setTitle] = useState("");
  const [editions, setEditions] = useState<Edition[]>([]);
  const [editionId, setEditionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>("Загрузка…");
  const [percent, setPercent] = useState(0);
  const [cfi, setCfi] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(110);
  const [font, setFont] = useState("literata");
  const [panel, setPanel] = useState<null | "kindle" | "search" | "type">(null);
  const [remote, setRemote] = useState<Progress | null>(null);

  const edition = editions.find((e) => e.id === editionId) ?? null;

  // 1. Загружаем книгу, версии и последнюю позицию
  useEffect(() => {
    me.current = deviceName();
    try {
      const fs = Number(localStorage.getItem("fontSize")); if (fs) setFontSize(fs);
      const f = localStorage.getItem("font"); if (f && FONTS.some((x) => x.id === f)) { setFont(f); fontRef.current = f; }
    } catch {}
    (async () => {
      const { data: pair } = await supabase
        .from("book_pairs").select("title, editions(*)").eq("id", pairId).single();
      if (!pair) return setStatus("Книга не найдена.");
      setTitle(pair.title);
      const eds = (pair.editions as Edition[]).sort((x, y) => x.lang.localeCompare(y.lang));
      setEditions(eds);
      const { data: prog } = await supabase.from("progress").select("*").eq("pair_id", pairId).maybeSingle();
      if (prog?.edition_id && eds.some((e) => e.id === prog.edition_id)) {
        jumpRef.current = { cfi: prog.cfi ?? undefined, percent: prog.percent ?? undefined };
        lastSaved.current = prog.updated_at;
        setEditionId(prog.edition_id);
      } else setEditionId(eds[0]?.id ?? null);
    })();
  }, [pairId]);

  // 2. Сохранение позиции (с небольшой задержкой, чтобы не писать на каждой странице)
  const save = useCallback(
    (c: string, p: number, edId: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const updated_at = new Date().toISOString();
        lastSaved.current = updated_at;
        await supabase.from("progress").upsert({
          pair_id: pairId, edition_id: edId, cfi: c, percent: p, device: me.current, updated_at,
        });
      }, 1200);
    },
    [pairId]
  );

  // 3. Открываем выбранную языковую версию
  useEffect(() => {
    if (!edition || !viewRef.current) return;
    let cancelled = false;
    const ed = edition;
    (async () => {
      setStatus("Открываю книгу…");
      rendRef.current?.destroy?.();
      bookRef.current?.destroy?.();
      viewRef.current!.innerHTML = "";

      const { data: blob, error } = await supabase.storage.from("books").download(ed.file_path);
      if (error || !blob) return setStatus("Не удалось скачать файл: " + error?.message);
      const ePub = (await import("epubjs")).default as any;
      const book = ePub(await blob.arrayBuffer());
      bookRef.current = book;
      await book.ready;

      // Разметка позиций: считается один раз и сохраняется в базе для всех устройств
      if (ed.locations) {
        book.locations.load(ed.locations);
      } else {
        setStatus("Размечаю книгу (только в первый раз, ~10–30 сек)…");
        await book.locations.generate(1000);
        const json = book.locations.save();
        await supabase.from("editions").update({ locations: json }).eq("id", ed.id);
        setEditions((all) => all.map((x) => (x.id === ed.id ? { ...x, locations: json } : x)));
      }
      if (cancelled) return;

      const rendition = book.renderTo(viewRef.current!, {
        width: "100%", height: "100%", spread: "none", flow: "paginated",
      });
      rendRef.current = rendition;
      rendition.themes.default({
        body: {
          "line-height": "1.6 !important",
          padding: "0 8px !important",
        },
        p: { "text-align": "justify", hyphens: "auto" },
      });
      rendition.themes.fontSize(`${fontSize}%`);

      // Свайпы и стрелки внутри страницы книги
      rendition.hooks.content.register((contents: any) => {
        const doc = contents.document as Document;
        // подключаем шрифты и выбранный шрифт внутрь страницы книги
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = `${window.location.origin}/fonts/fonts.css`;
        doc.head.appendChild(link);
        const style = doc.createElement("style");
        style.id = "user-font";
        style.textContent = fontCss(fontRef.current);
        doc.head.appendChild(style);
        const tstyle = doc.createElement("style");
        tstyle.id = "user-theme";
        tstyle.textContent = themeCss(darkRef.current);
        doc.head.appendChild(tstyle);
        let x0 = 0, y0 = 0;
        doc.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
        doc.addEventListener("touchend", (e) => {
          const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) dx < 0 ? rendition.next() : rendition.prev();
        });
        doc.addEventListener("keyup", onKey);
      });

      rendition.on("relocated", (loc: any) => {
        const c = loc.start.cfi as string;
        const p = book.locations.percentageFromCfi(c) ?? 0;
        setCfi(c); setPercent(p);
        save(c, p, ed.id);
      });

      const j = jumpRef.current;
      jumpRef.current = null;
      let target: string | undefined;
      if (j?.cfi) target = j.cfi;
      else if (j?.percent != null) target = book.locations.cfiFromPercentage(j.percent);
      await rendition.display(target);
      setStatus(null);
    })().catch((e) => setStatus("Ошибка: " + (e as Error).message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editionId]);

  // Размер шрифта
  useEffect(() => {
    rendRef.current?.themes.fontSize(`${fontSize}%`);
    try { localStorage.setItem("fontSize", String(fontSize)); } catch {}
  }, [fontSize]);

  // Выбор шрифта: применяем к уже открытым страницам и запоминаем
  useEffect(() => {
    fontRef.current = font;
    try { localStorage.setItem("font", font); } catch {}
    const contents = rendRef.current?.getContents?.() ?? [];
    for (const c of contents) {
      const el = c.document?.getElementById("user-font");
      if (el) el.textContent = fontCss(font);
    }
  }, [font]);

  // Тема: перекрашиваем уже открытые страницы
  useEffect(() => {
    const contents = rendRef.current?.getContents?.() ?? [];
    for (const c of contents) {
      const el = c.document?.getElementById("user-theme");
      if (el) el.textContent = themeCss(dark);
    }
  }, [dark]);

  // Стрелки на клавиатуре (MacBook)
  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.key === "ArrowRight") rendRef.current?.next();
    if (e.key === "ArrowLeft") rendRef.current?.prev();
  }, []);
  useEffect(() => {
    window.addEventListener("keyup", onKey);
    return () => window.removeEventListener("keyup", onKey);
  }, [onKey]);

  // Вернулся на вкладку — проверяем, не читал ли ты дальше на другом устройстве
  useEffect(() => {
    async function check() {
      if (document.visibilityState !== "visible") return;
      const { data } = await supabase.from("progress").select("*").eq("pair_id", pairId).maybeSingle();
      if (data && data.updated_at > lastSaved.current && data.device !== me.current && data.cfi !== cfi)
        setRemote(data);
    }
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check); };
  }, [pairId, cfi]);

  function goToPercent(p: number) {
    const book = bookRef.current;
    if (!book) return;
    rendRef.current.display(book.locations.cfiFromPercentage(Math.min(Math.max(p, 0), 0.9999)));
  }

  function switchLang(id: string) {
    if (id === editionId) return;
    jumpRef.current = { percent };
    setEditionId(id);
  }

  function acceptRemote() {
    if (!remote) return;
    lastSaved.current = remote.updated_at;
    if (remote.edition_id && remote.edition_id !== editionId) {
      jumpRef.current = { cfi: remote.cfi ?? undefined, percent: remote.percent ?? undefined };
      setEditionId(remote.edition_id);
    } else if (remote.cfi) rendRef.current?.display(remote.cfi);
    setRemote(null);
  }

  const kindleHints = editions
    .filter((e) => e.kindle_total_locs)
    .map((e) => `Kindle ${e.lang} ≈ ${Math.max(1, Math.round(percent * e.kindle_total_locs!))}`);

  return (
    <div className="flex h-dvh flex-col" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {/* Верхняя панель */}
      <header className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
        <Link href="/" className="btn-ghost px-3">←</Link>
        <div className="serif hidden min-w-0 flex-1 truncate text-base sm:block">{title}</div>
        <div className="flex-1 sm:hidden" />
        <div className="flex overflow-hidden rounded-lg border border-line">
          {editions.map((e) => (
            <button key={e.id} onClick={() => switchLang(e.id)}
              className={`px-3 py-2 font-medium ${e.id === editionId ? "bg-ink text-paper" : "hover:bg-card"}`}>
              {e.lang}
            </button>
          ))}
        </div>
        <button className="btn-ghost px-3" onClick={() => setPanel(panel === "type" ? null : "type")}>Aa</button>
        <button className="btn-ghost px-3" onClick={() => setPanel(panel === "search" ? null : "search")}>🔍</button>
        <button className="btn-ghost px-3" onClick={() => setPanel(panel === "kindle" ? null : "kindle")}>Kindle</button>
      </header>

      {remote && (
        <div className="flex items-center gap-3 bg-accent/10 px-4 py-2 text-sm">
          <span className="flex-1">
            На {remote.device} ты дочитал до {Math.round((remote.percent ?? 0) * 100)}%
            {remote.edition_id !== editionId && ` (${editions.find((e) => e.id === remote.edition_id)?.lang})`}.
          </span>
          <button className="btn-primary py-1" onClick={acceptRemote}>Перейти</button>
          <button className="text-muted" onClick={() => setRemote(null)}>✕</button>
        </div>
      )}

      {panel === "kindle" && edition && (
        <KindlePanel edition={edition} editions={editions}
          onGo={(p) => { goToPercent(p); setPanel(null); }}
          onSaveTotal={(id, total) => setEditions((all) => all.map((x) => (x.id === id ? { ...x, kindle_total_locs: total } : x)))} />
      )}
      {panel === "type" && (
        <div className="space-y-3 border-b border-line bg-card/60 px-4 py-3 text-sm">
          <div className="flex items-center gap-3">
            <span className="w-16 text-muted">Размер</span>
            <button className="btn-ghost px-4" onClick={() => setFontSize((s) => Math.max(70, s - 10))}>A−</button>
            <span className="w-12 text-center">{fontSize}%</span>
            <button className="btn-ghost px-4" onClick={() => setFontSize((s) => Math.min(200, s + 10))}>A+</button>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 text-muted">Тема</span>
            <ThemeSwitch theme={theme} />
          </div>
          <div className="flex flex-wrap gap-2">
            {FONTS.map((f) => (
              <button key={f.id} onClick={() => setFont(f.id)}
                style={{ fontFamily: f.css ?? undefined }}
                className={`rounded-lg border px-3 py-2 text-base ${f.id === font ? "border-ink bg-ink text-paper" : "border-line bg-card hover:border-ink"}`}>
                {f.name} · Аа
              </button>
            ))}
          </div>
        </div>
      )}
      {panel === "search" && (
        <SearchPanel book={bookRef.current} onGo={(c) => { rendRef.current?.display(c); setPanel(null); }} />
      )}

      {/* Страница книги */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={viewRef} className="absolute inset-0 mx-auto max-w-3xl px-2 py-4" />
        {status && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper text-muted">{status}</div>
        )}
      </div>

      {/* Нижняя панель */}
      <footer className="flex items-center gap-3 border-t border-line px-3 py-2 text-sm"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <button className="btn-ghost px-5" onClick={() => rendRef.current?.prev()}>‹</button>
        <div className="flex-1 text-center text-muted">
          {Math.round(percent * 1000) / 10}%
          {kindleHints.length > 0 && <span className="ml-2">· {kindleHints.join(" · ")}</span>}
        </div>
        <button className="btn-ghost px-5" onClick={() => rendRef.current?.next()}>›</button>
      </footer>
    </div>
  );
}

function KindlePanel({ edition, editions, onGo, onSaveTotal }: {
  edition: Edition; editions: Edition[];
  onGo: (p: number) => void; onSaveTotal: (id: string, total: number) => void;
}) {
  const [edId, setEdId] = useState(edition.id);
  const ed = editions.find((e) => e.id === edId)!;
  const [loc, setLoc] = useState("");
  const [total, setTotal] = useState(ed.kindle_total_locs ? String(ed.kindle_total_locs) : "");
  const [pct, setPct] = useState("");

  async function go() {
    if (pct) return onGo(Number(pct.replace(",", ".")) / 100);
    const l = Number(loc), t = Number(total);
    if (!l || !t) return;
    if (t !== ed.kindle_total_locs) {
      await supabase.from("editions").update({ kindle_total_locs: t }).eq("id", ed.id);
      onSaveTotal(ed.id, t);
    }
    onGo(l / t);
  }

  return (
    <div className="space-y-3 border-b border-line bg-card/60 px-4 py-3 text-sm">
      <div className="text-muted">
        Открой в Kindle меню → внизу будет «Loc 1234 of 5678» (или «Позиция … из …»). Введи оба числа.
        Общее число запомнится — дальше достаточно вводить только позицию.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>В Kindle книга на</span>
        <select className="input w-20 py-1" value={edId}
          onChange={(e) => { setEdId(e.target.value); const n = editions.find((x) => x.id === e.target.value); setTotal(n?.kindle_total_locs ? String(n.kindle_total_locs) : ""); }}>
          {editions.map((e) => <option key={e.id} value={e.id}>{e.lang}</option>)}
        </select>
        <input className="input w-24 py-1" inputMode="numeric" placeholder="Loc" value={loc} onChange={(e) => setLoc(e.target.value)} />
        <span>из</span>
        <input className="input w-24 py-1" inputMode="numeric" placeholder="всего" value={total} onChange={(e) => setTotal(e.target.value)} />
        <span className="text-muted">или</span>
        <input className="input w-20 py-1" inputMode="decimal" placeholder="%" value={pct} onChange={(e) => setPct(e.target.value)} />
        <button className="btn-primary py-1" onClick={go}>Перейти</button>
      </div>
      <div className="text-muted">
        Позиция примерная (± страница). Для точного места используй 🔍 — поиск по фразе с экрана Kindle.
      </div>
    </div>
  );
}

function SearchPanel({ book, onGo }: { book: any; onGo: (cfi: string) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ cfi: string; excerpt: string }[] | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!book || q.trim().length < 3) return;
    setBusy(true);
    const out: { cfi: string; excerpt: string }[] = [];
    for (const item of book.spine.spineItems) {
      try {
        await item.load(book.load.bind(book));
        out.push(...(item.search ? item.search(q.trim()) : item.find(q.trim())));
        item.unload();
      } catch {}
      if (out.length >= 20) break;
    }
    setRes(out);
    setBusy(false);
  }

  return (
    <div className="border-b border-line bg-card/60 px-4 py-3 text-sm">
      <form onSubmit={run} className="flex gap-2">
        <input className="input py-1" autoFocus placeholder="3–5 слов с экрана Kindle" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary py-1" disabled={busy}>{busy ? "…" : "Найти"}</button>
      </form>
      {res && res.length === 0 && <p className="mt-2 text-muted">Не нашёл. Попробуй фразу короче, без знаков препинания.</p>}
      {res && res.length > 0 && (
        <ul className="mt-2 max-h-56 divide-y divide-line overflow-auto">
          {res.map((r, i) => (
            <li key={i}><button className="w-full py-2 text-left hover:text-accent" onClick={() => onGo(r.cfi)}>…{r.excerpt}…</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ThemeSwitch({ theme }: { theme: string }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-line">
      {THEMES.map((t) => (
        <button key={t.id} onClick={() => setTheme(t.id)}
          className={`px-3 py-2 ${t.id === theme ? "bg-ink text-paper" : "hover:bg-card"}`}>
          {t.name}
        </button>
      ))}
    </div>
  );
}
