/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Kindle Loc ↔ место в EPUB — по тому же правилу, по которому Kindle (формат KFX) расставляет локации:
 *  • «позиция» = 1 символ текста абзаца (пробелы схлопываются, по краям абзаца отбрасываются),
 *    плюс по 1 позиции на сам раздел (файл книги), на контейнер (блок, внутри которого другие блоки)
 *    и на картинку/линию;
 *  • локация ставится каждые 110 позиций, отсчёт начинается заново с начала каждого раздела.
 * Если на Kindle общее число локаций немного другое (другая сборка книги) — пересчитываем пропорционально.
 */

const PER_LOC = 110;

const BLOCK = new Set(
  ("p div h1 h2 h3 h4 h5 h6 li ul ol blockquote pre table thead tbody tfoot tr td th caption " +
   "dl dd dt figure figcaption section article aside header footer nav main address center")
    .split(" ")
);
const ATOM = new Set(["img", "image", "svg", "video", "audio", "hr", "object", "math"]);
const SKIP = new Set(["script", "style", "head", "title", "meta", "link"]);

type TextEntry = { node: Text; pos: number; raw: string; lead: boolean };
export type KSection = { P: number; texts: TextEntry[] };
export type KModel = { secs: KSection[]; locBefore: number[]; locCount: number[]; total: number };

function bodyOf(doc: Document): Element | null {
  return doc.querySelector("body") ?? doc.getElementsByTagName("body")[0] ?? null;
}

const isWs = (c: string) => /\s/.test(c);
const BLOCK_SEL = [...BLOCK].join(",");

/** Сколько позиций занимает кусок текста после схлопывания пробелов */
function countNorm(raw: string, prevWs: boolean): { n: number; ws: boolean } {
  let n = 0, ws = prevWs;
  for (const ch of raw) {
    if (isWs(ch)) { if (!ws) { n++; ws = true; } }
    else { n++; ws = false; }
  }
  return { n, ws };
}

/** Разметка одного раздела книги в позициях Kindle */
export function sectionModel(doc: Document): KSection {
  const texts: TextEntry[] = [];
  let pos = 1;          // сам раздел
  let ws = true;        // в начале блока пробелы не считаются
  let trailing = false; // последний учтённый символ — пробел (в конце блока его убираем)

  const endBlock = () => { if (trailing) { pos--; trailing = false; } ws = true; };

  const walk = (el: Element) => {
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType === 3) {
        const raw = ch.nodeValue ?? "";
        texts.push({ node: ch as Text, pos, raw, lead: ws });
        const { n, ws: endWs } = countNorm(raw, ws);
        if (n > 0) trailing = endWs;
        pos += n;
        ws = endWs;
      } else if (ch.nodeType === 1) {
        const tag = ((ch as Element).localName || "").toLowerCase();
        if (SKIP.has(tag)) continue;
        if (ATOM.has(tag)) { pos += 1; ws = false; trailing = false; continue; }
        if (tag === "br") { if (!ws) { pos += 1; ws = true; trailing = true; } continue; }
        if (BLOCK.has(tag)) {
          endBlock();
          if ((ch as Element).querySelector(BLOCK_SEL)) pos += 1; // контейнер с блоками внутри
          walk(ch as Element);
          endBlock();
        }
        else walk(ch as Element); // строчный элемент (курсив, ссылка…) — просто текст
      }
    }
  };
  const body = bodyOf(doc);
  if (body) { walk(body); endBlock(); }
  return { P: pos, texts };
}

/** Позиция внутри раздела для точки (текстовый узел + смещение) */
function posOfPoint(sec: KSection, node: Node, offset: number): number | null {
  const e = sec.texts.find((t) => t.node === node);
  if (!e) return null;
  return e.pos + countNorm(e.raw.slice(0, offset), e.lead).n;
}

/** Точка (текстовый узел + смещение) для позиции внутри раздела */
function pointOfPos(sec: KSection, q: number): [Node, number] | null {
  let e: TextEntry | null = null;
  for (const t of sec.texts) {
    if (t.pos <= q && countNorm(t.raw, t.lead).n > 0) e = t;
    if (t.pos > q && e) break;
  }
  if (!e) e = sec.texts.find((t) => t.raw.trim()) ?? null;
  if (!e) return null;
  let need = Math.max(0, q - e.pos), ws = e.lead, i = 0;
  for (; i < e.raw.length && need > 0; i++) {
    const c = e.raw[i];
    if (isWs(c)) { if (!ws) { need--; ws = true; } } else { need--; ws = false; }
  }
  // не начинаем с пробела
  while (i < e.raw.length && isWs(e.raw[i])) i++;
  return [e.node, Math.min(i, e.raw.length)];
}

export async function buildModel(book: any): Promise<KModel> {
  const secs: KSection[] = [], locBefore: number[] = [], locCount: number[] = [];
  let acc = 0;
  for (const item of book.spine.spineItems) {
    let sec: KSection = { P: 0, texts: [] };
    try {
      await item.load(book.load.bind(book));
      if (item.document) sec = sectionModel(item.document);
    } catch {}
    secs[item.index] = sec;
    locBefore[item.index] = acc;
    locCount[item.index] = sec.P > 0 ? Math.ceil(sec.P / PER_LOC) : 0;
    acc += locCount[item.index];
  }
  return { secs, locBefore, locCount, total: acc };
}

/** Loc на Kindle → CFI в EPUB. kindleTotal — сколько всего локаций показывает Kindle. */
export function kindleToCfi(book: any, m: KModel, loc: number, kindleTotal: number): string | null {
  const scaled = kindleTotal && Math.abs(kindleTotal - m.total) > 1 ? (loc - 1) * (m.total / kindleTotal) + 1 : loc;
  const L = Math.min(Math.max(1, scaled), m.total);
  let idx = -1;
  for (let i = 0; i < m.locCount.length; i++) {
    const Lf = Math.floor(L);
    if (m.locCount[i] && Lf > m.locBefore[i] && Lf <= m.locBefore[i] + m.locCount[i]) { idx = i; break; }
  }
  if (idx < 0) return null;
  const within = L - m.locBefore[idx] - 1;                 // номер локации внутри раздела (с дробной частью)
  const q = Math.min(m.secs[idx].P - 1, Math.round(within * PER_LOC));
  const item = book.spine.get(idx);
  const pt = item?.document ? pointOfPos(m.secs[idx], q) : null;
  if (!item || !pt) return item?.cfiBase ? `epubcfi(${item.cfiBase}!/4/2)` : null;
  const range = item.document.createRange();
  range.setStart(pt[0], pt[1]);
  range.setEnd(pt[0], pt[1]);
  return item.cfiFromRange(range);
}

/** Текущая страница (начало) → Loc на Kindle */
export function locFromRendition(rendition: any, m: KModel, cfi: string, secIdx: number, kindleTotal: number): number | null {
  try {
    const range = rendition.getRange(cfi);
    if (!range) return null;
    const sec = sectionModel(range.startContainer.ownerDocument); // та же разметка, но по показанной странице
    let node: Node = range.startContainer, off = range.startOffset;
    if (node.nodeType !== 3) {
      // начало страницы попало на элемент — берём первый текст внутри/после него
      const doc = node.ownerDocument!;
      const w = doc.createTreeWalker(node.childNodes[off] ?? node, 4);
      const t = w.nextNode();
      if (t) { node = t; off = 0; }
    }
    const q = posOfPoint(sec, node, off);
    if (q == null || m.locBefore[secIdx] == null) return null;
    const ours = m.locBefore[secIdx] + Math.floor(q / PER_LOC) + 1;
    const scaled = kindleTotal && Math.abs(kindleTotal - m.total) > 1 ? (ours - 1) * (kindleTotal / m.total) + 1 : ours;
    return Math.max(1, Math.round(scaled));
  } catch {
    return null;
  }
}
