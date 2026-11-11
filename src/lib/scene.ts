"use client";
/**
 * Картинка «где мы остановились»: поиск уже нарисованной для этого места и рисование новой.
 */
import { supabase } from "@/lib/supabase";

export type Scene = { caption: string; picture?: string; url: string | null; note?: string };

// подпись к картинке хранится в том же поле, что и пересказ (через пустую строку) — без изменений в базе
const SEP = "\n\n🖼 ";
const pack = (caption: string, picture?: string) => (picture ? caption + SEP + picture : caption);
const unpack = (s: string) => { const i = s.indexOf(SEP); return i < 0 ? { caption: s } : { caption: s.slice(0, i), picture: s.slice(i + SEP.length) }; };

const NEAR = 0.008; // ±0.8% книги — считаем «тем же местом»

async function token(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Уже нарисованная картинка для этого места (если есть) */
export async function findCachedScene(pairId: string, editionId: string, pos: number): Promise<Scene | null> {
  const { data, error } = await supabase
    .from("scenes").select("edition_id,pos,caption,image_path,created_at")
    .eq("pair_id", pairId).order("created_at", { ascending: false });
  if (error || !data) return null;
  const near = data.filter((s: any) => Math.abs(s.pos - pos) <= NEAR && s.image_path);
  const best = near.find((s: any) => s.edition_id === editionId) ?? near[0];
  if (!best) return null;
  const { data: signed } = await supabase.storage.from("scenes").createSignedUrl(best.image_path, 60 * 60);
  return signed?.signedUrl ? { ...unpack(best.caption ?? ""), url: signed.signedUrl } : null;
}

export class SceneError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Нарисовать новую картинку. onCaption вызывается сразу, как только готов пересказ (картинка — позже). */
export async function generateScene(opts: {
  pairId: string; editionId: string; pos: number; title: string; text: string;
  page?: string; bookTitle?: string; author?: string;
  onCaption?: (c: string) => void; signal?: { cancelled: boolean };
}): Promise<Scene> {
  const t = await token();
  if (!t) throw new SceneError("unauthorized", "Нужно войти заново.");
  const auth = { Authorization: `Bearer ${t}` };

  const r = await fetch("/api/scene", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text: opts.text, title: opts.title, page: opts.page, bookTitle: opts.bookTitle, author: opts.author }),
  });
  if (r.status === 501) throw new SceneError("not_configured", "Картинки ещё не подключены: нужен ключ Яндекса в настройках Vercel.");
  if (r.status === 401) throw new SceneError("unauthorized", "Нет доступа к рисованию (проверь ALLOWED_EMAILS в Vercel).");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new SceneError("failed", `Не получилось разобрать сцену (${j.detail ?? j.error ?? r.status}).`);
  const caption: string = j.caption ?? "";
  const picture: string = j.picture ?? "";
  if (caption) opts.onCaption?.(caption);
  if (opts.signal?.cancelled) throw new SceneError("cancelled", "");

  // Рисуем (обычно 10–30 секунд)
  const d = await fetch("/api/scene", {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: j.prompt ?? caption }),
  });
  const dj = await d.json().catch(() => ({}));
  if (opts.signal?.cancelled) throw new SceneError("cancelled", "");
  const image: string | null = dj.image ?? null;
  if (!image) return { caption, picture, url: null, note: `Картинку нарисовать не получилось — только пересказ. (${dj.error ?? d.status})` };

  // Сохраняем, чтобы в следующий раз показать сразу
  const bytes = Uint8Array.from(atob(image), (ch) => ch.charCodeAt(0));
  const blob = new Blob([bytes], { type: bytes[0] === 0x89 ? "image/png" : "image/jpeg" });
  const url = URL.createObjectURL(blob);
  try {
    const { data: u } = await supabase.auth.getUser();
    const path = `${u.user!.id}/${opts.pairId}/${Date.now()}.${blob.type === "image/png" ? "png" : "jpg"}`;
    const up = await supabase.storage.from("scenes").upload(path, blob, { contentType: blob.type });
    if (!up.error) {
      await supabase.from("scenes").insert({
        pair_id: opts.pairId, edition_id: opts.editionId, pos: opts.pos, caption: pack(caption, picture), image_path: path,
      });
    }
  } catch { /* не сохранилось — не страшно, покажем всё равно */ }
  return { caption, picture, url };
}
