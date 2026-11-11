import { createClient } from "@supabase/supabase-js";

// Оба значения публичные (их и так видно в браузере); данные защищены правилами доступа в базе.
// Можно переопределить через переменные окружения в Vercel.
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://fhvjoqukvisnaofytgjt.supabase.co";
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_JFQSDa-b_rj5pN-pazQg_g_ihbUs9oF";

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
