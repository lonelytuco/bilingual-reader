"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase, deviceName, saveProgressKeepalive, type Edition, type Progress } from "@/lib/supabase";
import { useTheme, setTheme, THEMES, READER_COLORS } from "@/lib/theme";
import { sentencesOf, locate, countSentences, pointAt, norm, type Sent } from "@/lib/align";
import { translate } from "@/lib/translate";
import { findCachedScene, generateScene, SceneError } from "@/lib/scene";
import { buildModel, kindleToCfi, locFromRendition, type KModel } from "@/lib/kindle";

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
    const done = () => { (doc as any).__fontsDone = true; res(); };
    link.onload = () => { (doc as any).fonts?.ready.then(done) ?? done(); };
    link.onerror = done;
    setTimeout(done, 3000);
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
  const pendingSave = useRef<any>(null);   // позиция, которую ещё не отправили на сервер
  const authRef = useRef<{ uid: string; token: string } | null>(null);
  const readyRef = useRef(false);          // книга открыта на нужном месте — можно сохранять
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
  const navTok = useRef(0); // номер последнего перехода (чтобы не мешать, если пользователь уже листает дальше)
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
  // Перевод выделенного фрагмента — как в другой версии этой книги
  type Preview = { target: Edition; status: "loading" | "done"; source: string; match?: Match };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLang, setPreviewLang] = useState<string | null>(null);
  const prevTok = useRef(0);
  // Картинка «где мы остановились»
  type SceneView = { status: "loading" | "ready" | "error"; caption?: string; picture?: string; url?: string | null; note?: string };
  const [scene, setScene] = useState<SceneView | null>(null);
  const sceneTok = useRef({ cancelled: false });
  const sessionGapRef = useRef<number>(0); // сколько прошло с прошлого чтения на момент открытия
  const autoSceneDone = useRef(false);
  // Kindle
  const modelsRef = useRef(new Map<string, Promise<KModel>>());
  const [kHint, setKHint] = useState<string | null>(null);

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
      const { data: server } = await supabase.from("progress").select("*").eq("pair_id", pairId).maybeSingle();
      // позиция на этом устройстве (пишется сразу при каждом перелистывании) — берём ту, что новее
      let local: any = null;
      try { local = JSON.parse(localStorage.getItem(`pos:${pairId}`) ?? "null"); } catch {}
      const prog = local && (!server || local.updated_at > server.updated_at) ? local : server;
      sessionGapRef.current = prog?.updated_at ? Date.now() - Date.parse(prog.updated_at) : 0;
      if (prog?.edition_id && eds.some((e) => e.id === prog.edition_id)) {
        jumpRef.current = { cfi: prog.cfi ?? undefined, percent: prog.percent ?? undefined };
        lastSaved.current = prog.updated_at;
        setEditionId(prog.edition_id);
      } else setEditionId(eds[0]?.id ?? null);
    })();
  }, [pairId]);

  // 2. Сохранение позиции.
  //    • сразу — на этом устройстве (localStorage), чтобы ничего не потерялось;
  //    • через полсекунды — на сервер (для других устройств); при уходе со страницы — немедленно.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) authRef.current = { uid: data.session.user.id, token: data.session.access_token };
    });
    const { data } = supabase.auth.onAuthStateChange((_e, sess) => {
      authRef.current = sess ? { uid: sess.user.id, token: sess.access_token } : null;
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const row = pendingSave.current, a = authRef.current;
    if (!row || !a) return;
    pendingSave.current = null;
    saveProgressKeepalive({ ...row, user_id: a.uid }, a.token).catch(() => {
      // не получилось — попробуем ещё раз обычным способом
      supabase.from("progress").upsert(row).then(() => {}, () => {});
    });
  }, []);

  const save = useCallback(
    (c: string, p: number, edId: string) => {
      if (!readyRef.current) return; // книга ещё открывается — не затираем сохранённое место
      const updated_at = new Date().toISOString();
      const row = { pair_id: pairId, edition_id: edId, cfi: c, percent: p, device: me.current, updated_at };
      lastSaved.current = updated_at;
      try { localStorage.setItem(`pos:${pairId}`, JSON.stringify(row)); } catch {}
      pendingSave.current = row;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 500);
    },
    [pairId, flush]
  );

  // Ушёл со страницы / свернул приложение / вернулся в библиотеку — отправляем сразу
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

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

  // ——— Kindle ———
  const getModel = useCallback((ed: Edition): Promise<KModel> => {
    const c = modelsRef.current.get(ed.id);
    if (c) return c;
    const p = getBook(ed).then(buildModel);
    p.catch(() => modelsRef.current.delete(ed.id));
    modelsRef.current.set(ed.id, p);
    return p;
  }, [getBook]);

  /** Пересчитать подсказку «на Kindle ≈ Loc …» для текущей страницы */
  const updateKindleHint = useCallback(async (loc: any) => {
    const ed = editionRef.current, r = rendRef.current;
    if (!ed || !r || !loc?.start || !ed.kindle_total_locs) { setKHint(null); return; }
    try {
      const m = await getModel(ed);
      const n = locFromRendition(r, m, loc.start.cfi, loc.start.index, ed.kindle_total_locs);
      if (n != null) setKHint(`Kindle ${n}`);
    } catch { /* разметка ещё не готова */ }
  }, [getModel]);
  const kHintRef = useRef(updateKindleHint);
  kHintRef.current = updateKindleHint;

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
      readyRef.current = false;
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
        kHintRef.current(loc);
        save(c, p, ed.id);
      });

      const j = jumpRef.current;
      jumpRef.current = null;
      let target: string | undefined;
      if (j?.cfi) target = j.cfi;
      else if (j?.percent != null) target = book.locations.cfiFromPercentage(j.percent);
      try {
        await displayAt(target);
      } catch {
        // сохранённое место не открылось — открываем по проценту, а не с начала книги
        if (j?.percent != null) await displayAt(book.locations.cfiFromPercentage(j.percent));
        else await displayAt();
      }
      if (cancelled) return;
      readyRef.current = true;
      // вернулся к книге после перерыва — показываем, что происходит
      if (!autoSceneDone.current && sessionGapRef.current > 20 * 60 * 1000) {
        autoSceneDone.current = true;
        let off = false;
        try { off = sessionStorage.getItem("scene:off") === "1"; } catch {}
        if (!off) setTimeout(() => sceneRef.current(false), 300);
      }
      // запоминаем место, на котором книга реально открылась
      const cur = rendition.currentLocation?.();
      if (cur?.start?.cfi) save(cur.start.cfi, book.locations.percentageFromCfi(cur.start.cfi) ?? 0, ed.id);
      setStatus(null);
      if (j?.highlight) addHighlight(j.highlight);
      paginate();
    })().catch((e) => setStatus("Ошибка: " + (e as Error).message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editionId]);

  // Убираем отображение при уходе со страницы
  useEffect(() => () => { pagTokenRef.current++; disposeRef.current?.(); }, []);

  /** Ждём, пока шрифты на отображаемой странице догрузятся (иначе текст «переливается» на другие страницы) */
  async function fontsSettled(r: any) {
    const docs = (r.getContents?.() ?? []).map((c: any) => c.document).filter(Boolean);
    const pending = docs.filter((d: any) => d.__fontsReady && !d.__fontsDone).map((d: any) => d.__fontsReady);
    if (!pending.length) return false;
    await Promise.all(pending);
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(null))));
    return true;
  }

  /** Открыть место и, если шрифт догрузился позже, ещё раз точно встать на него */
  const displayAt = useCallback(async (target?: string) => {
    const r = rendRef.current;
    if (!r) return;
    const tok = ++navTok.current;
    await r.display(target);
    const at = target ?? r.currentLocation?.()?.start?.cfi;
    if (await fontsSettled(r) && tok === navTok.current && at) await r.display(at);
  }, []);

  // После смены шрифта/размера/экрана: остаться на том же месте и пересчитать страницы
  const relayout = useCallback(() => {
    const r = rendRef.current;
    const at = lastLocRef.current?.start?.cfi;
    if (!r || !at) return;
    pagTokenRef.current++;
    setPage(null);
    setTimeout(async () => {
      try { await displayAt(at); } catch {}
      paginate();
    }, 300);
  }, [paginate, displayAt]);

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
        const tok = ++navTok.current;
        await (dir > 0 ? r.next() : r.prev());
        const startCfi = r.currentLocation?.()?.start?.cfi;
        fontsSettled(r).then((changed) => { if (changed && tok === navTok.current && startCfi) r.display(startCfi); });
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
      const tok = ++navTok.current;
      try { await (dir > 0 ? r.next() : r.prev()); } catch {}
      await raf(); await raf(); // epub.js сообщает новую позицию в следующем кадре
      // новая глава ещё догружает шрифт → после этого возвращаемся к той же первой строке
      const startCfi = r.currentLocation?.()?.start?.cfi;
      fontsSettled(r).then((changed) => { if (changed && tok === navTok.current && startCfi) r.display(startCfi); });
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
    displayAt(book.locations.cfiFromPercentage(Math.min(Math.max(p, 0), 0.9999)));
  }

  /** Перейти на Loc с Kindle (в той версии, что на Kindle) */
  async function goKindle(edId: string, loc: number, total: number) {
    const ed = editions.find((e) => e.id === edId);
    if (!ed) return;
    try {
      setNotice(null);
      const [book, m] = await Promise.all([getBook(ed), getModel(ed)]);
      const target = kindleToCfi(book, m, loc, total);
      if (!target) throw new Error("не нашёл место");
        clearHighlight();
      if (ed.id === editionId) await displayAt(target);
      else { jumpRef.current = { cfi: target }; setEditionId(ed.id); }
    } catch (e) {
      setNotice("Ошибка: " + (e as Error).message);
    }
  }

  /** Показать картинку для текущего места: из сохранённых или нарисовать новую */
  async function showScene(force: boolean) {
    const ed = editionRef.current;
    if (!ed) return;
    sceneTok.current.cancelled = true;
    const tok = { cancelled: false };
    sceneTok.current = tok;
    const pos = percent;
    setScene({ status: "loading" });
    try {
      if (!force) {
        const cached = await findCachedScene(pairId, ed.id, pos);
        if (tok.cancelled) return;
        if (cached) { setScene({ status: "ready", ...cached }); return; }
      }
      // текст на экране сейчас — это и рисуем
      let page = "";
      try {
        const r = rendRef.current, loc = lastLocRef.current;
        const a = r?.getRange(loc.start.cfi), b = r?.getRange(loc.end.cfi);
        if (a && b) {
          const rg = a.startContainer.ownerDocument.createRange();
          rg.setStart(a.startContainer, a.startOffset);
          rg.setEnd(b.endContainer, b.endOffset);
          page = rg.toString().replace(/\s+/g, " ").trim();
        }
      } catch {}
      // предыдущий текст (~6000 знаков) — контекст: кто, где, что было до этого
      const idx = await textIndex(ed);
      const before = idx.sents.filter((s) => s.pos <= pos + 0.001);
      let text = "";
      for (let i = before.length - 1; i >= 0 && text.length < 6000; i--) text = before[i].text + " " + text;
      if (!text.trim() && !page) { setScene({ status: "error", note: "Здесь пока нечего рисовать — начни читать." }); return; }
      // название и автор — из самого файла книги
      let bookTitle = "", author = "";
      try {
        const md = (await getBook(ed)).packaging?.metadata ?? {};
        bookTitle = String(md.title ?? "").trim();
        author = String(md.creator ?? "").trim();
      } catch {}
      const res = await generateScene({
        pairId, editionId: ed.id, pos, title, text: text || page, page, bookTitle, author, signal: tok,
        onCaption: (c) => { if (!tok.cancelled) setScene({ status: "loading", caption: c }); },
      });
      if (!tok.cancelled) setScene({ status: res.url ? "ready" : "error", ...res });
    } catch (e) {
      if (tok.cancelled) return;
      const code = e instanceof SceneError ? e.code : "failed";
      if (code === "not_configured") { try { sessionStorage.setItem("scene:off", "1"); } catch {} }
      setScene((s) => ({ status: "error", caption: s?.caption, note: (e as Error).message || "Не получилось нарисовать." }));
    }
  }
  const sceneRef = useRef(showScene);
  sceneRef.current = showScene;

  function closeScene() {
    sceneTok.current.cancelled = true;
    setScene(null);
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
    } else if (remote.cfi) displayAt(remote.cfi);
    setRemote(null);
  }

  // ——— Выделение и переход в другую версию ———

  // Выделил текст → через мгновение показываем, как этот фрагмент переведён в другой версии книги.
  // Панель не исчезает сама, когда выделение сбрасывается (на iPad это бывает при нажатии на кнопку).
  useEffect(() => {
    if (!sel || !edition) return;
    const others = editions.filter((e) => e.id !== edition.id);
    if (!others.length) return;
    const target = others.find((e) => e.id === previewLang) ?? others[0];
    const tok = ++prevTok.current;
    const source = { text: sel.text, sec: sel.sec };
    const t = setTimeout(async () => {
      setPreview({ target, status: "loading", source: source.text });
      try {
        const match = await computeMatch(source, edition, target);
        if (tok === prevTok.current) setPreview({ target, status: "done", source: source.text, match });
      } catch (e) {
        if (tok === prevTok.current)
          setPreview({ target, status: "done", source: source.text, match: { mark: null, srcPos: percent, mt: "", error: (e as Error).message } });
      }
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.cfi, sel?.text, previewLang]);

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
  function clearAll() {
    clearHighlight();
  }

  function clearHighlight() {
    const r = rendRef.current;
    if (hlRef.current && r) { try { r.annotations.remove(hlRef.current, "highlight"); } catch {} }
    hlRef.current = null;
    setHl(null);
    for (const c of r?.getContents?.() ?? []) { try { c.window.getSelection()?.removeAllRanges(); } catch {} }
    setSel(null);
  }

  type Match = { mark: Mark | null; srcPos: number; mt: string; error?: string };

  /** Найти фрагмент во второй версии книги: текст переводчика книги + место для перехода */
  async function computeMatch(source: { text: string; sec: number }, from: Edition, target: Edition): Promise<Match> {
    const { text } = source;
    let error: string | undefined;
    const trP = translate(text, from.lang, target.lang).catch((e: Error) => {
      error = e.message;
      return { text: "", truncated: false };
    });
    const [sIdx, tIdx, tr] = await Promise.all([textIndex(from), textIndex(target), trP]);

    // Где выделение в исходной книге: ищем предложение, с которого оно начинается
    let srcPos = percent;
    const nt = norm(text);
    for (const needle of [nt.slice(0, 24), nt.slice(-24), nt.slice(Math.floor(nt.length / 2), Math.floor(nt.length / 2) + 24)]) {
      const cands = sIdx.sents.filter((s) => (source.sec < 0 || s.sec === source.sec) && norm(s.text).includes(needle));
      if (cands.length) {
        cands.sort((a, b) => Math.abs(a.pos - percent) - Math.abs(b.pos - percent));
        srcPos = cands[0].pos;
        break;
      }
    }

    // Самое близкое по смыслу место в пределах ±10% книги от той же позиции
    const pool = tIdx.sents.filter((s) => Math.abs(s.pos - srcPos) <= 0.1);
    const hits = tr.text
      ? locate(pool, tr.text, srcPos, text.length * (tIdx.total / sIdx.total), tr.truncated, countSentences(text))
      : [];
    if (!hits.length || hits[0].sim < 0.1) return { mark: null, srcPos, mt: tr.text, error };

    const tb = await getBook(target);
    const h = hits[0];
    const s = pool[h.start], e = pool[h.end];
    const range = s.el.ownerDocument.createRange();
    range.setStart(...pointAt(s.el, s.start));
    range.setEnd(...pointAt(e.el, e.end));
    return { mark: { cfi: tb.spine.get(s.sec).cfiFromRange(range), text: range.toString().replace(/\s+/g, " ").trim() }, srcPos, mt: tr.text };
  }

  /** Перейти во вторую версию на найденное место (с подсветкой) */
  function openMatch(target: Edition, m: Match) {
    clearAll();
    setPreview(null);
    if (m.mark) jumpRef.current = { cfi: m.mark.cfi, highlight: m.mark };
    else jumpRef.current = { percent: m.srcPos };
    setEditionId(target.id);
  }

  /** Из подсвеченного фрагмента — обратно в другую версию */
  async function findInOther(target: Edition) {
    const source = sel ?? (hl ? { ...hl, sec: -1 } : null);
    if (!source || !edition) return;
    try {
      setXBusy("Ищу это место…");
      openMatch(target, await computeMatch(source, edition, target));
    } catch (e) {
      setNotice("Ошибка: " + (e as Error).message);
    } finally {
      setXBusy(null);
    }
  }



  const marked = preview || sel ? null : hl;

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
        <button className="btn-ghost px-3" onClick={() => showScene(false)} title="Что сейчас происходит">🖼</button>
        <button className="btn-ghost px-3" onClick={() => setPanel(panel === "type" ? null : "type")}>Aa</button>
        <button className="btn-ghost px-3" onClick={() => setPanel(panel === "search" ? null : "search")}>🔍</button>
        <button className="btn-ghost px-3" onClick={() => setPanel(panel === "kindle" ? null : "kindle")}>Kindle</button>
      </header>

      {preview && (
        <div className="border-b border-line bg-card/70 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-muted">
            <span>Перевод в книге</span>
            {editions.filter((e) => e.id !== editionId).length > 1 ? (
              <div className="flex overflow-hidden rounded-md border border-line">
                {editions.filter((e) => e.id !== editionId).map((e) => (
                  <button key={e.id} onClick={() => setPreviewLang(e.id)}
                    className={`px-2 py-0.5 ${e.id === preview.target.id ? "bg-ink text-paper" : ""}`}>{e.lang}</button>
                ))}
              </div>
            ) : <span>· {preview.target.lang}</span>}
            <span className="flex-1" />
            <button className="px-1 hover:text-ink" onClick={() => { prevTok.current++; setPreview(null); }} title="Закрыть">✕</button>
          </div>
          {preview.status === "loading" && (
            <div className="mt-2 animate-pulse text-muted">Ищу этот фрагмент в версии {preview.target.lang}…</div>
          )}
          {preview.status === "done" && preview.match?.mark && (
            <div className="serif mt-2 max-h-48 overflow-auto text-base leading-relaxed text-ink">
              {preview.match.mark.text}
            </div>
          )}
          {preview.status === "done" && !preview.match?.mark && (
            <div className="mt-2">
              <div className="text-xs text-muted">
                {preview.match?.error ? preview.match.error + " " : ""}
                {preview.match?.mt ? "Точного места в книге рядом не нашлось. Машинный перевод:" : "Не получилось найти перевод."}
              </div>
              {preview.match?.mt && <div className="serif mt-1 text-base leading-relaxed text-ink">{preview.match.mt}</div>}
            </div>
          )}
          {preview.status === "done" && preview.match && (
            <button className="btn-primary mt-3 py-1" onClick={() => openMatch(preview.target, preview.match!)}>
              Открыть в {preview.target.lang} →
            </button>
          )}
        </div>
      )}
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
            <button className="btn-ghost shrink-0 py-1" onClick={clearAll} title="Снять выделение">
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
          onGo={(id, loc, total) => { goKindle(id, loc, total); setPanel(null); }}
          onPercent={(p) => { goToPercent(p); setPanel(null); }}
          getTotal={async (id) => { const e = editions.find((x) => x.id === id); return e ? (await getModel(e)).total : null; }}
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
        <SearchPanel book={bookRef.current} onGo={(c) => { displayAt(c); setPanel(null); }} />
      )}

      {/* Страница книги */}
      <div ref={stageRef} className="relative flex-1 overflow-hidden">
        <div ref={animRef} className="absolute inset-0 flex items-center justify-center will-change-transform">
          <div ref={viewRef} />
        </div>
        {status && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper text-muted">{status}</div>
        )}
        {scene && !status && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-paper/85 p-4 backdrop-blur-sm" onClick={closeScene}>
            <div className="w-full max-w-xl rounded-2xl border border-line bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 text-xs uppercase tracking-widest text-muted">Где мы остановились</div>
              <div className="relative aspect-video overflow-hidden rounded-xl bg-line">
                {scene.url
                  ? <img src={scene.url} alt={scene.caption ?? "Сцена"} className="h-full w-full object-cover" />
                  : scene.status === "loading"
                    ? <div className="flex h-full w-full animate-pulse items-center justify-center text-sm text-muted">Рисую сцену…</div>
                    : <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted">{scene.note}</div>}
              </div>
              {scene.url && scene.picture && (
                <p className="mt-2 text-sm italic leading-snug text-muted">{scene.picture}</p>
              )}
              {scene.caption
                ? <p className="serif mt-3 text-lg leading-snug">{scene.caption}</p>
                : scene.status === "loading" && <p className="mt-3 animate-pulse text-muted">Вспоминаю, что происходит…</p>}
              {scene.url && scene.note && <p className="mt-1 text-xs text-muted">{scene.note}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn-primary" onClick={closeScene}>Читать дальше</button>
                {scene.status !== "loading" && (
                  <button className="btn-ghost" onClick={() => showScene(true)}>Нарисовать заново</button>
                )}
              </div>
            </div>
          </div>
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
            {kHint && <> · {kHint}</>}
          </div>
        </div>
        <button className="btn-ghost px-5" onClick={() => turn(1)}>›</button>
      </footer>
    </div>
  );
}

function KindlePanel({ edition, editions, onGo, onPercent, getTotal, onSaveTotal }: {
  edition: Edition; editions: Edition[];
  onGo: (edId: string, loc: number, total: number) => void;
  onPercent: (p: number) => void;
  getTotal: (edId: string) => Promise<number | null>;
  onSaveTotal: (id: string, total: number) => void;
}) {
  const [edId, setEdId] = useState(edition.kindle_total_locs ? edition.id : (editions.find((e) => e.kindle_total_locs)?.id ?? edition.id));
  const ed = editions.find((e) => e.id === edId)!;
  const [loc, setLoc] = useState("");
  const [total, setTotal] = useState(ed.kindle_total_locs ? String(ed.kindle_total_locs) : "");
  const [pct, setPct] = useState("");
  const [calc, setCalc] = useState<number | null>(null);

  useEffect(() => { setCalc(null); getTotal(edId).then(setCalc).catch(() => {}); }, [edId, getTotal]);

  async function go() {
    if (pct) return onPercent(Number(pct.replace(",", ".")) / 100);
    const l = Number(loc), t = Number(total);
    if (!l || !t) return;
    if (t !== ed.kindle_total_locs) {
      await supabase.from("editions").update({ kindle_total_locs: t }).eq("id", ed.id);
      onSaveTotal(ed.id, t);
    }
    onGo(ed.id, l, t);
  }
  const t = Number(total);
  const diff = calc && t ? Math.abs(calc - t) / t : null;

  return (
    <div className="space-y-3 border-b border-line bg-card/60 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Kindle:</span>
        <select className="input w-20 py-1" value={edId}
          onChange={(e) => { setEdId(e.target.value); const n = editions.find((x) => x.id === e.target.value); setTotal(n?.kindle_total_locs ? String(n.kindle_total_locs) : ""); }}>
          {editions.map((e) => <option key={e.id} value={e.id}>{e.lang}</option>)}
        </select>
        <input className="input w-24 py-1" inputMode="numeric" placeholder="Loc" value={loc} autoFocus onChange={(e) => setLoc(e.target.value)} />
        <span>из</span>
        <input className="input w-24 py-1" inputMode="numeric" placeholder="всего" value={total} onChange={(e) => setTotal(e.target.value)} />
        <span className="text-muted">или</span>
        <input className="input w-20 py-1" inputMode="decimal" placeholder="%" value={pct} onChange={(e) => setPct(e.target.value)} />
        <button className="btn-primary py-1" onClick={go}>Перейти</button>
      </div>
      <div className="text-muted">
        {calc == null ? "Считаю локации книги…" : (
          <>По расчёту в этой книге {calc.toLocaleString("ru")} локаций
            {diff != null && (diff < 0.003 ? " — совпадает с Kindle ✓" : ` (на Kindle ${t.toLocaleString("ru")} — сборка немного отличается, пересчитаю пропорционально)`)}.
          </>
        )}
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
