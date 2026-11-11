"use client";
/**
 * Примерный перевод фрагмента для поиска того же места в другой версии.
 * 1) Если на сервере задан ключ ANTHROPIC_API_KEY — переводит Claude (лучше и без дневного лимита).
 * 2) Иначе — бесплатный MyMemory прямо из браузера (≈5000 знаков в день, по 500 байт за запрос).
 * Для поиска хватает начала фрагмента, поэтому переводим максимум ~2 куска.
 */

const enc = new TextEncoder();

function chunks(text: string, maxBytes = 480, maxChunks = 2): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (enc.encode(cur + p).length <= maxBytes) { cur += p; continue; }
    if (cur) out.push(cur.trim());
    if (out.length >= maxChunks) return out;
    // одно очень длинное предложение — режем по словам
    let piece = "";
    for (const w of p.split(/(\s+)/)) {
      if (enc.encode(piece + w).length > maxBytes) break;
      piece += w;
    }
    cur = piece;
  }
  if (cur && out.length < maxChunks) out.push(cur.trim());
  return out;
}

export async function translate(text: string, from: string, to: string): Promise<{ text: string; truncated: boolean }> {
  const src = text.replace(/­/g, "").replace(/\s+/g, " ").trim();
  const f = from.toLowerCase(), t = to.toLowerCase();
  const key = `tr2:${f}:${t}:${src.slice(0, 300)}`;
  try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch {}
  let truncated = src.length > 1500;

  let result = "";
  // 1. Свой сервер (Claude), если настроен
  try {
    const r = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: src.slice(0, 1500), from: f, to: t }),
    });
    if (r.ok) result = ((await r.json()).text ?? "").trim();
  } catch {}

  // 2. MyMemory
  if (!result) {
    const out: string[] = [];
    const parts = chunks(src);
    truncated = parts.join(" ").length < src.length * 0.9;
    for (const part of parts) {
      const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(part)}&langpair=${f}|${t}`;
      const r = await fetch(u);
      const j = await r.json();
      const tr: string = j?.responseData?.translatedText ?? "";
      if (/MYMEMORY WARNING|QUOTA/i.test(tr) || j?.responseStatus === 429)
        throw new Error("Бесплатный лимит перевода на сегодня закончился.");
      if (tr) out.push(tr);
    }
    result = out.join(" ");
  }
  if (!result) throw new Error("Не удалось перевести фрагмент.");
  const res = { text: result, truncated };
  try { localStorage.setItem(key, JSON.stringify(res)); } catch {}
  return res;
}
