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
