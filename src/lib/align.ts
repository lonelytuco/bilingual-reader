/**
 * Поиск «того же места» в другой языковой версии книги.
 * Сравниваем переведённый фрагмент с предложениями другой версии по общим «основам» слов
 * (первые 5 букв — грубо, но устойчиво к падежам и разным формулировкам переводчиков),
 * числам и именам, с поправкой на ожидаемую позицию в книге.
 */

const STOP = new Set(
  (
    "the and that with was for his her you not but this from have had they she him are were what all one there " +
    "which been would could into then them when who its their your our out about said over only very just also " +
    "что это как так его она они был была было были для уже ещё еще или если только когда меня мне тебя вот все " +
    "всё нет даже себя чтобы этот эта тот там тут который которая которые потом теперь него неё ему ней них свой"
  ).split(" ")
);

export function tokens(text: string): string[] {
  const words = text.toLowerCase().replace(/­/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (/\d/.test(w)) { out.push(w); continue; }
    if (w.length < 3 || STOP.has(w)) continue;
    out.push(w.length > 5 ? w.slice(0, 5) : w);
  }
  return out;
}

/** Сходство двух наборов слов, 0…1 (коэффициент Дайса с учётом повторов) */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const m = new Map<string, number>();
  for (const t of a) m.set(t, (m.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const k = m.get(t);
    if (k) { common++; m.set(t, k - 1); }
  }
  return (2 * common) / (a.length + b.length);
}

/** Разбивка текста на предложения с позициями (для точной подсветки) */
export function splitSentences(t: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /[^.!?…]*[.!?…]+["'»”)\]]*\s*|[^.!?…]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const lead = m[0].length - m[0].trimStart().length;
    const body = m[0].trim();
    if (body.length) out.push({ start: m.index + lead, end: m.index + lead + body.length });
  }
  return out;
}

export type Sent = {
  sec: number;     // номер файла (секции) внутри EPUB
  el: Element;     // абзац
  start: number;   // позиция начала в тексте абзаца
  end: number;
  text: string;
  tok: string[];
  off: number;     // сколько знаков книги до этого предложения
  pos: number;     // позиция в книге, 0…1 (считается по знакам)
};

const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, div, dd, dt, td, pre";

/** Все предложения одного файла книги, по абзацам, в порядке чтения. Не зависит от разметки глав. */
export function sentencesOf(doc: Document, sec: number): { sents: Sent[]; len: number } {
  const all = Array.from(doc.querySelectorAll(BLOCK));
  // берём только «листовые» блоки, чтобы не дублировать текст вложенных
  const leaves = all.filter((el) => !el.querySelector(BLOCK) && (el.textContent ?? "").trim().length > 0);
  const sents: Sent[] = [];
  let acc = 0;
  for (const el of leaves) {
    const text = el.textContent ?? "";
    for (const s of splitSentences(text)) {
      const t = text.slice(s.start, s.end);
      sents.push({ sec, el, start: s.start, end: s.end, text: t, tok: tokens(t), off: acc + s.start, pos: 0 });
    }
    acc += text.length;
  }
  return { sents, len: acc };
}

export function norm(t: string) {
  return t.replace(/\u00ad/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Находит лучшее место: start..end — индексы предложений (включительно).
 * translated — перевод (возможно только начала выделения), targetLen — ожидаемая длина всего фрагмента.
 */
export function findBest(sents: Sent[], translated: string, expectedPos: number, targetLen: number) {
  const q = tokens(translated);
  const qLen = Math.max(20, translated.length);
  let best = { i: -1, j: -1, score: 0 };
  for (let i = 0; i < sents.length; i++) {
    let len = 0;
    let tok: string[] = [];
    for (let j = i; j < sents.length && j < i + 12; j++) {
      if (sents[j].sec !== sents[i].sec) break;
      len += sents[j].text.length + 1;
      tok = tok.concat(sents[j].tok);
      // окна около длины перевода (от 0.6 до 1.6 от неё)
      if (len < qLen * 0.6) continue;
      const sim = similarity(q, tok);
      const dist = Math.abs(sents[i].pos - expectedPos);
      const score = sim - dist * 0.8;
      if (score > best.score) best = { i, j, score };
      if (len > qLen * 1.6) break;
    }
  }
  if (best.i < 0) return null;
  // если перевели только начало выделения — дотягиваем конец до ожидаемой длины
  let j = best.j;
  let len = 0;
  for (let k = best.i; k <= j; k++) len += sents[k].text.length + 1;
  while (j + 1 < sents.length && sents[j + 1].sec === sents[best.i].sec) {
    const next = len + sents[j + 1].text.length + 1;
    if (Math.abs(next - targetLen) >= Math.abs(len - targetLen)) break;
    len = next; j++;
  }
  return { start: best.i, end: j, score: best.score, sim: best.score };
}

/** Точка внутри абзаца по номеру символа → (текстовый узел, смещение) */
export function pointAt(el: Element, off: number): [Node, number] {
  const doc = el.ownerDocument;
  const w = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let n: Node | null;
  let acc = 0;
  let last: Node | null = null;
  while ((n = w.nextNode())) {
    const L = (n.textContent ?? "").length;
    if (acc + L >= off) return [n, off - acc];
    acc += L;
    last = n;
  }
  return [last ?? el, last ? (last.textContent ?? "").length : 0];
}

/** Вес слов: редкие (имена, конкретные предметы) важнее частых */
export function buildIdf(sents: Sent[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const s of sents) for (const t of new Set(s.tok)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = sents.length || 1;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / d));
  return idf;
}

function weighted(a: string[], b: string[], idf: Map<string, number>, dflt: number): number {
  if (!a.length || !b.length) return 0;
  const w = (t: string) => idf.get(t) ?? dflt;
  const m = new Map<string, number>();
  let wa = 0, wb = 0, common = 0;
  for (const t of a) { m.set(t, (m.get(t) ?? 0) + 1); wa += w(t); }
  for (const t of b) {
    wb += w(t);
    const k = m.get(t);
    if (k) { common += w(t); m.set(t, k - 1); }
  }
  return (2 * common) / (wa + wb);
}

export type Hit = { start: number; end: number; score: number; sim: number };

/**
 * Ищет по ВСЕЙ книге окна из 1…N подряд идущих предложений, похожие на перевод.
 * Близость к ожидаемому месту — мягкий бонус, а не жёсткий фильтр (версии бывают сдвинуты).
 * Возвращает до 3 лучших непересекающихся вариантов.
 */
export function locate(
  sents: Sent[], translated: string, expectedPos: number, targetLen: number, truncated: boolean, srcSentences = 1,
): Hit[] {
  const q = tokens(translated);
  if (!q.length || !sents.length) return [];
  const idf = buildIdf(sents);
  const dflt = Math.log(1 + sents.length); // слово, которого нет в книге, — «редкое»
  const qLen = Math.max(20, translated.length);
  const maxLen = Math.max(qLen * 1.5, 60);
  const hits: Hit[] = [];
  for (let i = 0; i < sents.length; i++) {
    const d = Math.abs(sents[i].pos - expectedPos);
    const near = 1 / (1 + (d / 0.08) ** 2);
    let len = 0;
    let tok: string[] = [];
    let best: Hit | null = null;
    for (let j = i; j < sents.length && j < i + 15; j++) {
      if (j > i && sents[j].sec !== sents[i].sec) break;
      len += sents[j].text.length + 1;
      tok = tok.concat(sents[j].tok);
      const sim = weighted(q, tok, idf, dflt);
      // смысл важнее места; число предложений обычно совпадает с выделением
      const shape = Math.pow(0.85, Math.abs(j - i + 1 - srcSentences));
      const score = sim * (0.55 + 0.45 * near) * shape;
      if (!best || score > best.score) best = { start: i, end: j, score, sim };
      if (len > maxLen) break;
    }
    if (best) hits.push(best);
  }
  hits.sort((a, b) => b.score - a.score);
  const out: Hit[] = [];
  for (const h of hits) {
    if (out.some((o) => !(h.end < o.start || h.start > o.end))) continue;
    out.push(h);
    if (out.length >= 3) break;
  }
  // перевели только начало длинного выделения — дотягиваем конец до ожидаемой длины
  if (truncated) {
    for (const h of out) {
      let len = 0;
      for (let k = h.start; k <= h.end; k++) len += sents[k].text.length + 1;
      while (h.end + 1 < sents.length && sents[h.end + 1].sec === sents[h.start].sec) {
        const next = len + sents[h.end + 1].text.length + 1;
        if (Math.abs(next - targetLen) >= Math.abs(len - targetLen)) break;
        len = next; h.end++;
      }
    }
  }
  return out;
}

/** Опорные точки (уже найденные соответствия позиций) → ожидаемая позиция в другой версии */
export function mapPos(pos: number, anchors: [number, number][]): number {
  if (!anchors.length) return pos;
  const a = [...anchors].sort((x, y) => x[0] - y[0]);
  if (pos <= a[0][0]) return Math.max(0, pos + (a[0][1] - a[0][0]));
  const last = a[a.length - 1];
  if (pos >= last[0]) return Math.min(1, pos + (last[1] - last[0]));
  for (let k = 0; k + 1 < a.length; k++) {
    const [s0, t0] = a[k], [s1, t1] = a[k + 1];
    if (pos >= s0 && pos <= s1) return s1 === s0 ? t0 : t0 + ((pos - s0) / (s1 - s0)) * (t1 - t0);
  }
  return pos;
}

export function countSentences(text: string) {
  return Math.max(1, splitSentences(text).length);
}
