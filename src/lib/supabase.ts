import { createClient } from "@supabase/supabase-js";

// Оба значения публичные (их и так видно в браузере); данные защищены правилами доступа в базе.
// Можно переопределить через переменные окружения в Vercel.
export const SUPABASE_URL_PUBLIC =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://fhvjoqukvisnaofytgjt.supabase.co";
export const SUPABASE_KEY_PUBLIC =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_JFQSDa-b_rj5pN-pazQg_g_ihbUs9oF";

const url = SUPABASE_URL_PUBLIC;
const key = SUPABASE_KEY_PUBLIC;

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export type BookPair = { id: string; title: string; created_at: string };
export type Edition = {
  id: string;
  pair_id: string;
  lang: string;
  file_path: string;
  kindle_total_locs: number | null;
  kindle_anchors?: [number, number][] | null;
  locations: string | null;
};
export type Progress = {
  pair_id: string;
  edition_id: string | null;
  cfi: string | null;
  percent: number | null;
  device: string | null;
  updated_at: string;
};

export function deviceName(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "браузер";
}

/**
 * Сохранить позицию так, чтобы запрос не оборвался при закрытии вкладки/приложения
 * (keepalive — браузер дошлёт его даже после ухода со страницы).
 */
export async function saveProgressKeepalive(row: {
  user_id: string; pair_id: string; edition_id: string; cfi: string; percent: number; device: string; updated_at: string;
}, accessToken: string) {
  const r = await fetch(`${url}/rest/v1/progress?on_conflict=user_id,pair_id`, {
    method: "POST",
    keepalive: true,
    headers: {
      apikey: key,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([row]),
  });
  if (!r.ok) throw new Error(`progress save failed: ${r.status}`);
}
