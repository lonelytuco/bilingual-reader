/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Связь «Loc на Kindle» ↔ место в EPUB.
 *
 * Kindle считает позиции по объёму файла книги (вместе с обложкой, оглавлением и разметкой),
 * а не по чистому тексту. Поэтому модель здесь тоже считает объём каждого файла книги в байтах,
 * а внутри файла — переходит к тексту пропорционально.
 * Остаточную разницу убирает «подстройка»: пары (наша оценка → настоящий Loc), которые даёт пользователь.
 */
import { mapPos, pointAt } from "@/lib/align";

export type KModel = { bytes: number[]; chars: number[]; before: number[]; totalBytes: number };
export type KAnchor = [number, number]; // [оценка модели 0…1, настоящая доля на Kindle 0…1]

function bodyOf(doc: Document): Element | null {
  return doc.querySelector("body") ?? doc.getElementsByTagName("body")[0] ?? null;
}

export async function buildModel(book: any): Promise<KModel> {
  const enc = new TextEncoder();
  const ser = new XMLSerializer();
  const bytes: number[] = [], chars: number[] = [], before: number[] = [];
  let acc = 0;
  for (const item of book.spine.spineItems) {
    let b = 0, c = 0;
    try {
      await item.load(book.load.bind(book));
      const doc: Document | undefined = item.document;
      if (doc) {
        b = enc.encode(ser.serializeToString(doc)).length;
        c = bodyOf(doc)?.textContent?.length ?? 0;
      }
    } catch {}
    before[item.index] = acc;
    bytes[item.index] = b;
    chars[item.index] = c;
    acc += b;
  }
  return { bytes, chars, before, totalBytes: acc || 1 };
}

/** Место в книге (файл + номер символа) → оценка доли на Kindle */
export function modelFromPos(m: KModel, sec: number, charOff: number): number {
  const c = m.chars[sec] || 1;
  const f = Math.min(1, Math.max(0, charOff / c));
  return (m.before[sec] + f * (m.bytes[sec] || 0)) / m.totalBytes;
}

/** Оценка доли на Kindle → место в книге (файл + номер символа) */
export function posFromModel(m: KModel, frac: number): { sec: number; charOff: number } {
  const target = Math.min(0.99999, Math.max(0, frac)) * m.totalBytes;
  let sec = 0;
  for (let i = 0; i < m.bytes.length; i++) {
    if (m.bytes[i] && m.before[i] <= target) sec = i;
  }
  const f = m.bytes[sec] ? (target - m.before[sec]) / m.bytes[sec] : 0;
  return { sec, charOff: Math.round(Math.min(1, Math.max(0, f)) * (m.chars[sec] || 0)) };
}

/** Loc на Kindle → CFI места в книге */
export function kindleToCfi(book: any, m: KModel, anchors: KAnchor[], loc: number, total: number): string | null {
  const real = loc / total;
  // подстройка: настоящая доля → оценка модели
  const est = mapPos(real, anchors.map(([e, r]) => [r, e] as [number, number]));
  let { sec, charOff } = posFromModel(m, est);
  // пропускаем пустые файлы (обложка-картинка и т. п.) — ведём к ближайшему тексту
  while (sec < m.chars.length - 1 && !m.chars[sec]) { sec++; charOff = 0; }
  const item = book.spine.get(sec);
  const body = item?.document ? bodyOf(item.document) : null;
  if (!item || !body) return null;
  const range = item.document.createRange();
  const [node, off] = pointAt(body, charOff);
  range.setStart(node, off);
  range.setEnd(node, off);
  return item.cfiFromRange(range);
}

/** Текущее место в отображаемой книге → оценка модели (до подстройки) */
export function estimateFromRendition(rendition: any, m: KModel, cfi: string, sec: number): number | null {
  try {
    const range = rendition.getRange(cfi);
    if (!range) return null;
    const doc: Document = range.startContainer.ownerDocument;
    const body = bodyOf(doc);
    if (!body) return null;
    const pre = doc.createRange();
    pre.setStart(body, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    return modelFromPos(m, sec, pre.toString().length);
  } catch {
    return null;
  }
}

/** Оценка модели → Loc на Kindle (с подстройкой) */
export function estimateToLoc(est: number, anchors: KAnchor[], total: number): number {
  return Math.max(1, Math.round(mapPos(est, anchors) * total));
}

/** Добавить точку подстройки (заменяя близкие) */
export function addAnchor(list: KAnchor[], est: number, real: number): KAnchor[] {
  const out = list.filter(([e]) => Math.abs(e - est) > 0.003);
  out.push([est, real]);
  return out.sort((a, b) => a[0] - b[0]).slice(-30);
}
