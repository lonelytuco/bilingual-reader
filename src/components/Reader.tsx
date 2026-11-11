"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase, deviceName, type Edition, type Progress } from "@/lib/supabase";
import { useTheme, setTheme, THEMES, READER_COLORS } from "@/lib/theme";
import { sentencesOf, findBest, pointAt, norm, type Sent } from "@/lib/align";
import { translate } from "@/lib/translate";

type Mark = { cfi: string; text: string };
type Jump = { cfi?: string; percent?: number; highlight?: Mark } | null;
type TIndex = { sents: Sent[]; total: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const even = (n: number) => Math.max(200, Math.floor(n / 2) * 2);

/** Создаёт отображение книги и умеет полностью его убрать — вместе с обработчиками, которые epub.js вешает на саму книгу */
function makeRendition(book: any, el: HTMLElement, w: number, h: number) {
  const hooks = book.spine.hooks.content.hooks as any[];
  const before = hooks.length;
  const r = book.renderTo(el, { width: w, height: h, spread: "none", flow: "paginated" });
  const added = hooks.slice(before);
  return {
    r,
    dispose: () => {
      added.forEach((f) => book.spine.hooks.content.deregister(f));
      try { r.destroy(); } catch {}
    },
  };
}

function applyLook(r: any, fontSize: number) {
  r.themes.default({
    body: { "line-height": "1.6 !important" },
    p: { "text-align": "justify", hyphens: "auto" },
  });
  r.themes.fontSize(`${fontSize}%`);
}

/** Подключает шрифты/тему внутрь страницы книги; doc.__fontsReady — когда шрифты догрузились */
function decorate(doc: Document, font: string, dark: boolean) {
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = `${window.location.origin}/fonts/fonts.css`;
  (doc as any).__fontsReady = new Promise<void>((res) => {
    link.onload = () => { (doc as any).fonts?.ready.then(() => res()) ?? res(); };
    link.onerror = () => res();
    setTimeout(res, 3000);
  });
  doc.head.appendChild(link);
  const style = doc.createElement("style");
  style.id = "user-font";
  style.textContent = fontCss(font);
  doc.head.appendChild(style);
  const tstyle = doc.createElement("style");
  tstyle.id = "user-theme";
  tstyle.textContent = themeCss(dark);
  doc.head.appendChild(tstyle);
}

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
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const rendRef = useRef<any>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const jumpRef = useRef<Jump>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>("");
  const me = useRef<string>("");
  const fontRef = useRef<string>("literata");
  const fontSizeRef = useRef<number>(110);
  const darkRef = useRef<boolean>(false);
  const sizeRef = useRef({ w: 600, h: 800 });
  const lastLocRef = useRef<any>(null);
  const turning = useRef(false);
  const editionRef = useRef<Edition | null>(null);
  const booksRef = useRef(new Map<string, Promise<any>>());
  const indexRef = useRef(new Map<string, Promise<TIndex>>());
  const pagesRef = useRef<{ key: string; counts: number[] } | null>(null);
  const pagTokenRef = useRef(0);
  const hlRef = useRef<string | null>(null);
  const [theme, dark] = useTheme();
  darkRef.current = dark;

  const [title, setTitle] = useState("");
  const [editions, setEditions] = useState<Edition[]>([]);
  const [editionId, setEditionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>("Загрузка…");
  const [percent, setPercent] = useState(0);
  const [page, setPage] = useState<{ n: number; total: number } | null>(null);
  const [paging, setPaging] = useState(false);
  const [cfi, setCfi] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(110);
  const [font, setFont] = useState("literata");
  const [panel, setPanel] = useState<null | "kindle" | "search" | "type">(null);
  const [remote, setRemote] = useState<Progress | null>(null);
  const [sel, setSel] = useState<(Mark & { sec: number }) | null>(null);
  const [hl, setHl] = useState<Mark | null>(null);
  const [xBusy, setXBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const edition = editions.find((e) => e.id === editionId) ?? null;
  editionRef.current = edition;
  fontRef.current = font;
  fontSizeRef.current = fontSize;

  // 1. Загружаем книгу, версии и последнюю позицию
  useEffect(() => {
    me.current = deviceName();
    try {
      const fs = Number(localStorage.getItem("fontSize")); if (fs) { setFontSize(fs); fontSizeRef.current = fs; }
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

  // Книга одной версии (кэшируется). Разметка позиций — куски по ~1000 знаков, только для % и синхронизации.
  const getBook = useCallback((ed: Edition, onStatus?: (s: string) => void): Promise<any> => {
    const cached = booksRef.current.get(ed.id);
    if (cached) return cached;
    const p = (async () => {
      const { data: blob, error } = await supabase.storage.from("books").download(ed.file_path);
      if (error || !blob) throw new Error("Не удалось скачать файл: " + error?.message);
      const mod = (await import("epubjs")) as any;
      const book = mod.default(await blob.arrayBuffer());
      await book.ready;
      if (ed.locations) {
        book.locations.load(ed.locations);
      } else {
        onStatus?.("Готовлю книгу (только в первый раз, ~10–30 сек)…");
        await book.locations.generate(1000);
        const json = book.locations.save();
        await supabase.from("editions").update({ locations: json }).eq("id", ed.id);
        setEditions((all) => all.map((x) => (x.id === ed.id ? { ...x, locations: json } : x)));
      }
      return book;
    })();
    p.catch(() => booksRef.current.delete(ed.id));
    booksRef.current.set(ed.id, p);
    return p;
  }, []);

  // Текст книги по предложениям (для поиска того же места в другой версии). Не зависит от разметки глав.
  const textIndex = useCallback((ed: Edition): Promise<TIndex> => {
    const cached = indexRef.current.get(ed.id);
    if (cached) return cached;
    const p = (async () => {
      const book = await getBook(ed);
      const sents: Sent[] = [];
      let acc = 0;
      for (const item of book.spine.spineItems) {
        if (!item.linear) continue;
        await item.load(book.load.bind(book));
        if (!item.document) continue;
        const r = sentencesOf(item.document, item.index);
        for (const s of r.sents) s.off += acc;
        sents.push(...r.sents);
        acc += r.len;
      }
      const total = acc || 1;
      for (const s of sents) s.pos = s.off / total;
      return { sents, total };
    })();
    p.catch(() => indexRef.current.delete(ed.id));
    indexRef.current.set(ed.id, p);
    return p;
  }, [getBook]);

  // Размер страницы — целые чётные пиксели (иначе колонки «плывут» и листание сбивается)
  const measure = useCallback(() => {
    const el = stageRef.current;
    const W = (el?.clientWidth ?? 600) - 24, H = (el?.clientHeight ?? 800) - 24;
    const size = { w: even(Math.min(W, 760)), h: even(H) };
    if (viewRef.current) {
      viewRef.current.style.width = size.w + "px";
      viewRef.current.style.height = size.h + "px";
    }
    return size;
  }, []);

  // Номер страницы: сколько экранов во всех файлах книги до текущего + страница в текущем
  const showPage = useCallback((loc: any) => {
    const pg = pagesRef.current;
    const d = loc?.start?.displayed;
    const idx: number | undefined = loc?.start?.index;
    if (!pg || !d || idx == null || pg.counts[idx] == null) { setPage(null); return; }
    let before = 0, total = 0;
    pg.counts.forEach((c, i) => { total += c || 0; if (i < idx) before += c || 0; });
    const n = before + Math.min(d.page, pg.counts[idx] || d.page);
    setPage({ n: Math.max(1, Math.min(n, total)), total: Math.max(total, 1) });
  }, []);

  // Честный подсчёт страниц: книга раскладывается на страницы в невидимом окне того же размера.
  // Результат запоминается для этого шрифта, размера и экрана.
  const paginate = useCallback(async () => {
    const book = bookRef.current, ed = editionRef.current;
    if (!book || !ed) return;
    const { w, h } = sizeRef.current;
    const key = `pg2:${ed.id}:${fontRef.current}:${fontSizeRef.current}:${w}x${h}`;
    const token = ++pagTokenRef.current;
    pagesRef.current = null;
    setPage(null);
    try {
      const c = localStorage.getItem(key);
      if (c) { pagesRef.current = { key, counts: JSON.parse(c) }; setPaging(false); showPage(lastLocRef.current); return; }
    } catch {}
    setPaging(true);
    const host = document.createElement("div");
    Object.assign(host.style, {
      position: "fixed", left: "-30000px", top: "0", width: w + "px", height: h + "px",
      visibility: "hidden", pointerEvents: "none",
    });
    document.body.appendChild(host);
    const { r, dispose } = makeRendition(book, host, w, h);
    applyLook(r, fontSizeRef.current);
    const f = fontRef.current;
    r.hooks.content.register((c: any) => decorate(c.document, f, false));
    const counts: number[] = [];
    try {
      for (const item of book.spine.spineItems) {
        if (token !== pagTokenRef.current) return;
        if (!item.linear) { counts[item.index] = 0; continue; }
        await r.display(item.href);
        const c = r.getContents()[0];
        if (c?.document?.__fontsReady) await c.document.__fontsReady;
        await sleep(80);
        const loc = r.currentLocation();
        counts[item.index] = loc?.start?.displayed?.total || 1;
      }
    } catch {
      return;
    } finally {
      dispose();
      host.remove();
    }
    if (token !== pagTokenRef.current) return;
    pagesRef.current = { key, counts };
    try { localStorage.setItem(key, JSON.stringify(counts)); } catch {}
    setPaging(false);
    showPage(lastLocRef.current);
  }, [showPage]);

  // 3. Открываем выбранную языковую версию
  useEffect(() => {
    if (!edition || !viewRef.current) return;
    let cancelled = false;
    const ed = edition;
    (async () => {
      setStatus("Открываю книгу…");
      disposeRef.current?.();
      disposeRef.current = null;
      rendRef.current = null;
      hlRef.current = null;
      setHl(null);
      setSel(null);
      viewRef.current!.innerHTML = "";

      const book = await getBook(ed, setStatus);
      if (cancelled) return;
      bookRef.current = book;
      const size = measure();
      sizeRef.current = size;

      const { r: rendition, dispose } = makeRendition(book, viewRef.current!, size.w, size.h);
      rendRef.current = rendition;
      disposeRef.current = dispose;
      applyLook(rendition, fontSizeRef.current);

      rendition.hooks.content.register((contents: any) => {
        const doc = contents.document as Document;
        decorate(doc, fontRef.current, darkRef.current);
        const hasSel = () => (doc.getSelection()?.toString() ?? "").trim().length > 0;
        doc.addEventListener("selectionchange", () => { if (!hasSel()) setSel(null); });
        // Свайпы на iPad
        let x0 = 0, y0 = 0;
        doc.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
        doc.addEventListener("touchmove", (e) => {
          if (hasSel()) return; // идёт выделение текста — не мешаем
          const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
          if (Math.abs(dx) > Math.abs(dy)) e.preventDefault(); // не даём Safari самому прокручивать страницы
        }, { passive: false });
        doc.addEventListener("touchend", (e) => {
          if (hasSel()) return;
          const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) turnRef.current(dx < 0 ? 1 : -1);
        });
        doc.addEventListener("keyup", (e) => keyRef.current(e));
      });

      rendition.on("selected", (range: string, contents: any) => {
        const text = (contents.window.getSelection()?.toString() ?? "").trim();
        if (text.length >= 8) { setSel({ cfi: range, text, sec: contents.sectionIndex }); setNotice(null); }
      });

      rendition.on("relocated", (loc: any) => {
        const c = loc.start.cfi as string;
        const p = book.locations.percentageFromCfi(c) ?? 0;
        setCfi(c); setPercent(p);
        lastLocRef.current = loc;
        showPage(loc);
        save(c, p, ed.id);
      });

      const j = jumpRef.current;
      jumpRef.current = null;
      let target: string | undefined;
      if (j?.cfi) target = j.cfi;
      else if (j?.percent != null) target = book.locations.cfiFromPercentage(j.percent);
      await rendition.display(target);
      if (cancelled) return;
      setStatus(null);
      if (j?.highlight) addHighlight(j.highlight);
      paginate();
    })().catch((e) => setStatus("Ошибка: " + (e as Error).message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editionId]);

  // Убираем отображение при уходе со страницы
  useEffect(() => () => { pagTokenRef.current++; disposeRef.current?.(); }, []);

  // После смены шрифта/размера/экрана: остаться на том же месте и пересчитать страницы
  const relayout = useCallback(() => {
    const r = rendRef.current;
    const at = lastLocRef.current?.start?.cfi;
    if (!r || !at) return;
    pagTokenRef.current++;
    setPage(null);
    setTimeout(async () => {
      try { await r.display(at); } catch {}
      paginate();
    }, 300);
  }, [paginate]);

  // Размер шрифта
  useEffect(() => {
    const r = rendRef.current;
    if (!r) return;
    r.themes.fontSize(`${fontSize}%`);
    try { localStorage.setItem("fontSize", String(fontSize)); } catch {}
    relayout();
  }, [fontSize, relayout]);

  // Шрифт
  useEffect(() => {
    try { localStorage.setItem("font", font); } catch {}
    const r = rendRef.current;
    if (!r) return;
    for (const c of r.getContents?.() ?? []) {
      const el = c.document?.getElementById("user-font");
      if (el) el.textContent = fontCss(font);
    }
    relayout();
  }, [font, relayout]);

  // Тема (на число страниц не влияет)
  useEffect(() => {
    for (const c of rendRef.current?.getContents?.() ?? []) {
      const el = c.document?.getElementById("user-theme");
      if (el) el.textContent = themeCss(dark);
    }
  }, [dark]);

  // Поворот iPad / изменение окна на Mac
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const r = rendRef.current;
        if (!r) return;
        const size = measure();
        if (size.w === sizeRef.current.w && size.h === sizeRef.current.h) return;
        sizeRef.current = size;
        try { r.resize(size.w, size.h); } catch {}
        relayout();
      }, 300);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure, relayout]);

  // Плавное перелистывание: страница уезжает в сторону, новая выезжает с другой стороны
  const turn = useCallback(async (dir: 1 | -1) => {
    const r = rendRef.current, el = animRef.current;
    if (!r || turning.current) return;
    turning.current = true;
    try {
      if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        await (dir > 0 ? r.next() : r.prev());
        return;
      }
      const shift = 28;
      const raf = () => new Promise((res) => requestAnimationFrame(() => res(null)));
      // 1) старая страница уезжает и гаснет
      el.style.transition = "transform 140ms ease-in, opacity 140ms ease-in";
      el.style.transform = `translateX(${dir > 0 ? -shift : shift}px)`;
      el.style.opacity = "0";
      await sleep(140);
      // 2) ВАЖНО: перед листанием возвращаем страницу на место — иначе epub.js
      //    неправильно определяет, какая страница на экране, и «перескакивает»
      el.style.transition = "none";
      el.style.transform = "none";
      try { await (dir > 0 ? r.next() : r.prev()); } catch {}
      await raf(); await raf(); // epub.js сообщает новую позицию в следующем кадре
      // 3) новая страница выезжает с другой стороны
      el.style.transform = `translateX(${dir > 0 ? shift : -shift}px)`;
      void el.offsetWidth;
      el.style.transition = "transform 200ms ease-out, opacity 200ms ease-out";
      el.style.transform = "translateX(0)";
      el.style.opacity = "1";
      await sleep(200);
      el.style.transition = "none";
      el.style.transform = "none";
    } finally {
      turning.current = false;
    }
  }, []);
  const turnRef = useRef(turn);
  turnRef.current = turn;

  // Стрелки и пробел (MacBook)
  const onKey = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowRight" || e.key === " ") turnRef.current(1);
    if (e.key === "ArrowLeft") turnRef.current(-1);
  }, []);
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
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
    rendRef.current?.display(book.locations.cfiFromPercentage(Math.min(Math.max(p, 0), 0.9999)));
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

  // ——— Выделение и переход в другую версию ———

  function addHighlight(m: Mark) {
    const r = rendRef.current;
    if (!r) return;
    clearHighlight();
    try {
      r.annotations.highlight(m.cfi, {}, () => clearHighlight(), "xl-hl",
        { fill: "#e08a5f", "fill-opacity": "0.35", "mix-blend-mode": "multiply" });
      hlRef.current = m.cfi;
      setHl(m);
    } catch {}
  }

  /** Снять подсветку и выделение */
  function clearHighlight() {
    const r = rendRef.current;
    if (hlRef.current && r) { try { r.annotations.remove(hlRef.current, "highlight"); } catch {} }
    hlRef.current = null;
    setHl(null);
    for (const c of r?.getContents?.() ?? []) { try { c.window.getSelection()?.removeAllRanges(); } catch {} }
    setSel(null);
  }

  async function findInOther(target: Edition) {
    const source = sel ?? (hl ? { ...hl, sec: -1 } : null);
    if (!source || !edition) return;
    const { text } = source;
    try {
      setXBusy("Перевожу…");
      const trP = translate(text, edition.lang, target.lang).catch((e: Error) => {
        setNotice(e.message + " Открываю примерно то же место.");
        return "";
      });
      const [sIdx, tIdx, translated] = await Promise.all([textIndex(edition), textIndex(target), trP]);

      // Где выделение в исходной книге (по знакам): ищем предложение, с которого оно начинается
      setXBusy("Ищу это место…");
      let srcPos = percent;
      const needle = norm(text).slice(0, 24);
      const cands = sIdx.sents.filter((s) => (source.sec < 0 || s.sec === source.sec) && norm(s.text).includes(needle));
      if (cands.length) {
        cands.sort((a, b) => Math.abs(a.pos - percent) - Math.abs(b.pos - percent));
        srcPos = cands[0].pos;
      }

      let found: ReturnType<typeof findBest> = null;
      let pool: Sent[] = [];
      if (translated) {
        const targetLen = text.length * (tIdx.total / sIdx.total);
        for (const win of [0.05, 0.15, 0.4]) {
          const c = tIdx.sents.filter((s) => Math.abs(s.pos - srcPos) <= win);
          const res = findBest(c, translated, srcPos, targetLen);
          if (res && (!found || res.sim > found.sim)) { found = res; pool = c; }
          if (found && found.sim >= 0.25) break;
        }
      }

      clearHighlight();
      if (found && found.sim >= 0.08) {
        const s = pool[found.start], e = pool[found.end];
        const tb = await getBook(target);
        const range = s.el.ownerDocument.createRange();
        range.setStart(...pointAt(s.el, s.start));
        range.setEnd(...pointAt(e.el, e.end));
        const mark = { cfi: tb.spine.get(s.sec).cfiFromRange(range), text: range.toString() };
        jumpRef.current = { cfi: mark.cfi, highlight: mark };
        if (found.sim < 0.2) setNotice("Место найдено приблизительно — переводы заметно отличаются.");
      } else {
        jumpRef.current = { percent: srcPos };
        if (translated) setNotice("Точно не нашёл — открыл примерно то же место.");
      }
      setEditionId(target.id);
    } catch (e) {
      setNotice("Ошибка: " + (e as Error).message);
    } finally {
      setXBusy(null);
    }
  }

  const kindleHints = editions
    .filter((e) => e.kindle_total_locs)
    .map((e) => `Kindle ${e.lang} ≈ ${Math.max(1, Math.round(percent * e.kindle_total_locs!))}`);

  const marked = sel ?? hl;

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

      {(marked || xBusy) && (
        <div className="flex items-center gap-2 border-b border-line bg-card/60 px-4 py-2 text-sm">
          <span className="serif min-w-0 flex-1 truncate text-muted">
            {xBusy ?? `«${marked!.text.slice(0, 80)}${marked!.text.length > 80 ? "…" : ""}»`}
          </span>
          {!xBusy && editions.filter((e) => e.id !== editionId).map((e) => (
            <button key={e.id} className="btn-primary shrink-0 py-1" onClick={() => findInOther(e)}>
              Найти в {e.lang} →
            </button>
          ))}
          {!xBusy && (
            <button className="btn-ghost shrink-0 py-1" onClick={clearHighlight} title="Снять выделение">
              ✕ Снять
            </button>
          )}
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
      <div ref={stageRef} className="relative flex-1 overflow-hidden">
        <div ref={animRef} className="absolute inset-0 flex items-center justify-center will-change-transform">
          <div ref={viewRef} />
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
            {page
              ? <>Стр. {page.n} <span className="text-muted">из {page.total}</span></>
              : <span className="text-muted">{paging ? "Считаю страницы…" : "\u00a0"}</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted opacity-80">
            {Math.round(percent * 100)}%
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
