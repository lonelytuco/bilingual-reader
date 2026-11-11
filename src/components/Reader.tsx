"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase, deviceName, type Edition, type Progress } from "@/lib/supabase";
import { useTheme, setTheme, THEMES, READER_COLORS } from "@/lib/theme";
import { sentencesOf, findBest, pointAt, type Sent } from "@/lib/align";
import { translate } from "@/lib/translate";

type Jump = { cfi?: string; percent?: number; highlight?: string } | null;
type Loaded = { book: any; starts: number[] };

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
  const [page, setPage] = useState<{ n: number; total: number; chapterLeft: number | null } | null>(null);
  const animRef = useRef<HTMLDivElement>(null);
  // Для подсчёта экранных страниц
  const cppRef = useRef<number[]>([]);          // сколько знаков помещается на один экран (замеры)
  const sectionStartRef = useRef<number[]>([]); // номер куска (1000 знаков), с которого начинается каждая глава
  const lastLocRef = useRef<any>(null);
  const turning = useRef(false);
  const [cfi, setCfi] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(110);
  const [font, setFont] = useState("literata");
  const [panel, setPanel] = useState<null | "kindle" | "search" | "type">(null);
  const [remote, setRemote] = useState<Progress | null>(null);
  // Выделение и переход в другую версию
  const booksRef = useRef(new Map<string, Promise<Loaded>>());
  const [sel, setSel] = useState<{ cfi: string; text: string } | null>(null);
  const [xBusy, setXBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hlRef = useRef<string | null>(null);

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

  // Загрузка книги одной версии (кэшируется: нужна и для чтения, и для поиска места)
  const getBook = useCallback((ed: Edition, onStatus?: (s: string) => void): Promise<Loaded> => {
    const cached = booksRef.current.get(ed.id);
    if (cached) return cached;
    const p = (async () => {
      const { data: blob, error } = await supabase.storage.from("books").download(ed.file_path);
      if (error || !blob) throw new Error("Не удалось скачать файл: " + error?.message);
      const mod = (await import("epubjs")) as any;
      const book = mod.default(await blob.arrayBuffer());
      await book.ready;
      // Разметка позиций: считается один раз и сохраняется в базе для всех устройств
      if (ed.locations) {
        book.locations.load(ed.locations);
      } else {
        onStatus?.("Размечаю книгу (только в первый раз, ~10–30 сек)…");
        await book.locations.generate(1000);
        const json = book.locations.save();
        await supabase.from("editions").update({ locations: json }).eq("id", ed.id);
        setEditions((all) => all.map((x) => (x.id === ed.id ? { ...x, locations: json } : x)));
      }
      // Где начинается каждая глава (в кусках по ~1000 знаков)
      const locs: string[] = book.locations._locations ?? [];
      const starts: number[] = [];
      locs.forEach((c: string, i: number) => {
        const sp = new mod.EpubCFI(c).spinePos;
        if (sp >= 0 && starts[sp] === undefined) starts[sp] = i;
      });
      const nSec = book.spine.spineItems.length;
      for (let i = nSec - 1, next = locs.length; i >= 0; i--) {
        if (starts[i] === undefined) starts[i] = next; else next = starts[i];
      }
      return { book, starts };
    })();
    p.catch(() => booksRef.current.delete(ed.id));
    booksRef.current.set(ed.id, p);
    return p;
  }, []);

  // 3. Открываем выбранную языковую версию
  useEffect(() => {
    if (!edition || !viewRef.current) return;
    let cancelled = false;
    const ed = edition;
    (async () => {
      setStatus("Открываю книгу…");
      rendRef.current?.destroy?.();
      viewRef.current!.innerHTML = "";

      const { book, starts } = await getBook(ed, setStatus);
      bookRef.current = book;
      sectionStartRef.current = starts;
      cppRef.current = [];
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
        doc.addEventListener("selectionchange", () => {
          if (!(doc.getSelection()?.toString() ?? "").trim()) setSel(null);
        });
        const hasSel = () => (doc.getSelection()?.toString() ?? "").trim().length > 0;
        doc.addEventListener("touchmove", (e) => {
          if (hasSel()) return; // идёт выделение текста — не мешаем
          const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
          if (Math.abs(dx) > Math.abs(dy)) e.preventDefault(); // не даём Safari самому прокручивать колонки
        }, { passive: false });
        doc.addEventListener("touchend", (e) => {
          if (hasSel()) return;
          const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) turnRef.current(dx < 0 ? 1 : -1);
        });
        doc.addEventListener("keyup", onKey);
      });

      rendition.on("selected", (range: string, contents: any) => {
        const text = (contents.window.getSelection()?.toString() ?? "").trim();
        if (text.length >= 8) { setSel({ cfi: range, text }); setNotice(null); }
      });

      rendition.on("relocated", (loc: any) => {
        const c = loc.start.cfi as string;
        const p = book.locations.percentageFromCfi(c) ?? 0;
        setCfi(c); setPercent(p);
        lastLocRef.current = loc;
        updatePages(loc);
        save(c, p, ed.id);
      });

      const j = jumpRef.current;
      jumpRef.current = null;
      let target: string | undefined;
      if (j?.cfi) target = j.cfi;
      else if (j?.percent != null) target = book.locations.cfiFromPercentage(j.percent);
      await rendition.display(target);
      setStatus(null);
      if (j?.highlight) {
        const h = j.highlight;
        hlRef.current = h;
        try {
          rendition.annotations.highlight(h, {}, () => clearHighlight(), "xl-hl",
            { fill: "#e08a5f", "fill-opacity": "0.35", "mix-blend-mode": "multiply" });
          const range = rendition.getRange(h);
          const win = range?.startContainer?.ownerDocument?.defaultView;
          if (range && win) { win.getSelection()?.removeAllRanges(); win.getSelection()?.addRange(range); }
        } catch {}
      }
    })().catch((e) => setStatus("Ошибка: " + (e as Error).message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editionId]);

  // Экранные страницы: меряем, сколько знаков влезает на экран при текущем шрифте,
  // и считаем по этому всю книгу. Внутри главы номер точный, между главами — оценка.
  const updatePages = useCallback((loc: any) => {
    const book = bookRef.current, r = rendRef.current;
    if (!book || !r || !loc?.start) return;
    const d = loc.start.displayed;
    const idx: number = loc.start.index;
    const view = r.getContents?.().find((c: any) => c.sectionIndex === idx) ?? r.getContents?.()[0];
    const chars = view?.document?.body?.textContent?.replace(/\s+/g, " ").length ?? 0;
    if (d?.total >= 3 && chars > 1500) {
      cppRef.current.push(chars / d.total);
      if (cppRef.current.length > 12) cppRef.current.shift();
    }
    const samples = cppRef.current;
    const cpp = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length
      : chars && d?.total ? Math.max(300, chars / d.total) : 1500;
    const totalChars = ((book.locations.total ?? 0) + 1) * 1000;
    const total = Math.max(1, Math.round(totalChars / cpp));
    const startChunk = sectionStartRef.current[idx] ?? 0;
    const n = Math.round((startChunk * 1000) / cpp) + (d?.page ?? 1);
    setPage({
      n: Math.min(Math.max(1, n), total),
      total,
      chapterLeft: d && d.total ? Math.max(0, d.total - d.page) : null,
    });
  }, []);

  // После смены шрифта/размера/окна: остаться на том же месте и пересчитать страницы
  const relayout = useCallback(() => {
    const r = rendRef.current;
    const at = lastLocRef.current?.start?.cfi;
    if (!r || !at) return;
    cppRef.current = [];
    setTimeout(async () => {
      try { await r.display(at); } catch {}
      const loc = r.currentLocation?.();
      if (loc?.start) { lastLocRef.current = loc; updatePages(loc); }
    }, 250);
  }, [updatePages]);

  // Размер шрифта
  useEffect(() => {
    rendRef.current?.themes.fontSize(`${fontSize}%`);
    try { localStorage.setItem("fontSize", String(fontSize)); } catch {}
    relayout();
  }, [fontSize, relayout]);

  // Поворот iPad / изменение окна на Mac
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(t); t = setTimeout(relayout, 300); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [relayout]);

  // Выбор шрифта: применяем к уже открытым страницам и запоминаем
  useEffect(() => {
    fontRef.current = font;
    try { localStorage.setItem("font", font); } catch {}
    const contents = rendRef.current?.getContents?.() ?? [];
    for (const c of contents) {
      const el = c.document?.getElementById("user-font");
      if (el) el.textContent = fontCss(font);
    }
    relayout();
  }, [font, relayout]);

  // Тема: перекрашиваем уже открытые страницы
  useEffect(() => {
    const contents = rendRef.current?.getContents?.() ?? [];
    for (const c of contents) {
      const el = c.document?.getElementById("user-theme");
      if (el) el.textContent = themeCss(dark);
    }
  }, [dark]);

  // Плавное перелистывание: страница уезжает в сторону, новая выезжает с другой стороны
  const turn = useCallback(async (dir: 1 | -1) => {
    const r = rendRef.current, el = animRef.current;
    if (!r || turning.current) return;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return dir > 0 ? r.next() : r.prev();
    }
    turning.current = true;
    const shift = 28;
    el.style.transition = "transform 140ms ease-in, opacity 140ms ease-in";
    el.style.transform = `translateX(${dir > 0 ? -shift : shift}px)`;
    el.style.opacity = "0";
    await new Promise((res) => setTimeout(res, 140));
    try { await (dir > 0 ? r.next() : r.prev()); } catch {}
    el.style.transition = "none";
    el.style.transform = `translateX(${dir > 0 ? shift : -shift}px)`;
    void el.offsetWidth; // перерисовка перед обратной анимацией
    el.style.transition = "transform 200ms ease-out, opacity 200ms ease-out";
    el.style.transform = "translateX(0)";
    el.style.opacity = "1";
    setTimeout(() => { turning.current = false; }, 200);
  }, []);
  const turnRef = useRef(turn);
  turnRef.current = turn;

  // Стрелки на клавиатуре (MacBook)
  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.key === "ArrowRight" || e.key === " ") turnRef.current(1);
    if (e.key === "ArrowLeft") turnRef.current(-1);
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

  function clearHighlight() {
    if (hlRef.current) { try { rendRef.current?.annotations.remove(hlRef.current, "highlight"); } catch {} }
    hlRef.current = null;
  }

  // Ищем выделенный фрагмент в другой языковой версии
  async function findInOther(target: Edition) {
    if (!sel || !edition) return;
    const { text, cfi: selCfi } = sel;
    try {
      setXBusy("Перевожу…");
      const [src, tgt] = await Promise.all([getBook(edition), getBook(target, setXBusy)]);
      let srcPos = percent;
      try { const p = src.book.locations.percentageFromCfi(selCfi); if (p != null && isFinite(p)) srcPos = p; } catch {}

      let translated = "";
      try { translated = await translate(text, edition.lang, target.lang); }
      catch (e) { setNotice((e as Error).message + " Открываю примерно то же место."); }

      setXBusy("Ищу это место…");
      const tb = tgt.book;
      const tTotal = (tb.locations.total ?? 0) + 1, sTotal = (src.book.locations.total ?? 0) + 1;
      const targetLen = text.length * (tTotal / sTotal);
      const nSec = tb.spine.spineItems.length;
      const secRange = (i: number) => [
        (tgt.starts[i] ?? tTotal) / tTotal,
        (i + 1 < nSec ? tgt.starts[i + 1] ?? tTotal : tTotal) / tTotal,
      ];

      async function search(win: number) {
        const sents: Sent[] = [];
        for (let i = 0; i < nSec; i++) {
          const [a, b] = secRange(i);
          if (b < srcPos - win || a > srcPos + win) continue;
          const section = tb.spine.get(i);
          if (!section || section.linear === "no" || section.linear === false) continue;
          await section.load(tb.load.bind(tb));
          if (section.document) sents.push(...sentencesOf(section.document, i, a, b));
        }
        return { sents, res: translated ? findBest(sents, translated, srcPos, targetLen) : null };
      }

      let found = translated ? await search(0.07) : null;
      if (translated && (!found?.res || found.res.sim < 0.18)) {
        const wide = await search(0.2);
        if (wide.res && (!found?.res || wide.res.sim > found.res.sim)) found = wide;
      }

      if (found?.res && found.res.sim >= 0.08) {
        const s = found.sents[found.res.start], e = found.sents[found.res.end];
        const range = s.el.ownerDocument.createRange();
        range.setStart(...pointAt(s.el, s.start));
        range.setEnd(...pointAt(e.el, e.end));
        const hl = tb.spine.get(s.sec).cfiFromRange(range);
        jumpRef.current = { cfi: hl, highlight: hl };
        if (found.res.sim < 0.2) setNotice("Место найдено приблизительно — переводы заметно отличаются.");
      } else {
        jumpRef.current = { percent: srcPos };
        if (translated) setNotice("Точно не нашёл — открыл примерно то же место.");
      }
      setSel(null);
      clearHighlight();
      setEditionId(target.id);
    } catch (e) {
      setNotice("Ошибка: " + (e as Error).message);
    } finally {
      setXBusy(null);
    }
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

      {(sel || xBusy) && (
        <div className="flex items-center gap-3 border-b border-line bg-card/60 px-4 py-2 text-sm">
          <span className="serif min-w-0 flex-1 truncate text-muted">
            {xBusy ?? `«${sel!.text.slice(0, 80)}${sel!.text.length > 80 ? "…" : ""}»`}
          </span>
          {!xBusy && editions.filter((e) => e.id !== editionId).map((e) => (
            <button key={e.id} className="btn-primary shrink-0 py-1" onClick={() => findInOther(e)}>
              Найти в {e.lang} →
            </button>
          ))}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-3 bg-accent/10 px-4 py-2 text-sm">
          <span className="flex-1">{notice}</span>
          <button className="text-muted" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
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
        <div ref={animRef} className="absolute inset-0 will-change-transform">
          <div ref={viewRef} className="absolute inset-0 mx-auto max-w-3xl px-2 py-4" />
        </div>
        {status && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper text-muted">{status}</div>
        )}
      </div>

      {/* Нижняя панель */}
      <footer className="flex items-center gap-3 border-t border-line px-3 py-2 text-sm"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <button className="btn-ghost px-5" onClick={() => turn(-1)}>‹</button>
        <div className="flex-1 text-center leading-tight">
          <div className="text-ink">
            {page ? <>Стр. {page.n} <span className="text-muted">из {page.total}</span></> : "\u00a0"}
          </div>
          <div className="mt-0.5 text-xs text-muted opacity-80">
            {Math.round(percent * 100)}%
            {page?.chapterLeft != null && <> · {page.chapterLeft === 0 ? "последняя стр. главы" : `в главе ещё ${page.chapterLeft}`}</>}
            {kindleHints.length > 0 && <> · {kindleHints.join(" · ")}</>}
          </div>
        </div>
        <button className="btn-ghost px-5" onClick={() => turn(1)}>›</button>
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
