/**
 * Картинка «где мы остановились»: YandexGPT выбирает сцену и пишет пересказ, Яндекс рисует.
 *
 * POST /api/scene  { text, title } → { caption, prompt }   (пересказ — сразу)
 * PUT  /api/scene  { prompt }      → { image } | { error }  (картинка, base64)
 *
 * Нужны переменные окружения в Vercel: YANDEX_API_KEY, YANDEX_FOLDER_ID.
 * Необязательно: ALLOWED_EMAILS — через запятую, кому разрешено (чтобы чужие не тратили твой баланс).
 */
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 60; // рисование занимает до ~30 секунд
import { SUPABASE_URL_PUBLIC, SUPABASE_KEY_PUBLIC } from "@/lib/supabase";

const API = "https://llm.api.cloud.yandex.net";

// Стиль: плоский минимализм
const STYLE =
  "Плоская минималистичная иллюстрация в стиле обложек Penguin и постеров Сола Басса: " +
  "2–3 приглушённых цвета, крупные простые силуэты, геометричные формы, много пустого пространства, " +
  "лёгкая бумажная текстура, без мелких деталей, без текста и надписей.";

const SYSTEM =
  "Ты — арт-директор книжных иллюстраций. Тебе дают фрагмент книги, который читатель только что прочитал. " +
  "Выбери ОДНУ ключевую сцену из самого конца фрагмента (то, что происходит прямо сейчас). " +
  'Ответь строго JSON без пояснений: {"caption": "...", "prompt": "..."}. ' +
  "caption — по-русски, 1–2 коротких предложения: что сейчас происходит, с именами героев, чтобы читатель быстро вспомнил. " +
  "prompt — по-русски, до 350 символов: что нарисовать (место, время суток, 1–2 фигуры и их действие, ключевой предмет, настроение). " +
  "В prompt не используй имена собственные и названия, только описания (например «пожилой смотритель маяка»). " +
  "Не описывай жестокость и откровенные сцены — выбери спокойный кадр с тем же смыслом.";

async function authorize(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const sb = createClient(SUPABASE_URL_PUBLIC, SUPABASE_KEY_PUBLIC, { auth: { persistSession: false } });
  const { data } = await sb.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const allowed = (process.env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) return null;
  return email;
}

function config() {
  const key = process.env.YANDEX_API_KEY, folder = process.env.YANDEX_FOLDER_ID;
  return key && folder ? { key, folder } : null;
}

const headers = (c: { key: string; folder: string }) => ({
  Authorization: `Api-Key ${c.key}`,
  "x-folder-id": c.folder,
  "Content-Type": "application/json",
});

function parseJson(s: string): { caption?: string; prompt?: string } {
  const m = s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : s); } catch { return {}; }
}

export async function POST(req: Request) {
  const c = config();
  if (!c) return Response.json({ error: "not_configured" }, { status: 501 });
  if (!(await authorize(req))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { text, title } = await req.json();
  if (!text || typeof text !== "string") return Response.json({ error: "no_text" }, { status: 400 });

  // 1) Сцена и пересказ
  const g = await fetch(`${API}/foundationModels/v1/completion`, {
    method: "POST",
    headers: headers(c),
    body: JSON.stringify({
      modelUri: `gpt://${c.folder}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.3, maxTokens: "600" },
      messages: [
        { role: "system", text: SYSTEM },
        { role: "user", text: `Книга: «${String(title ?? "").slice(0, 200)}»\n\nФрагмент:\n${text.slice(-6000)}` },
      ],
    }),
  });
  if (!g.ok) {
    const detail = (await g.text()).slice(0, 500);
    console.error("YandexGPT failed", g.status, detail);
    return Response.json({ error: "gpt_failed", detail: `${g.status}: ${detail}` }, { status: 502 });
  }
  const gj = await g.json();
  const out: string = gj?.result?.alternatives?.[0]?.message?.text ?? "";
  const { caption = "", prompt = "" } = parseJson(out);
  const scene = (prompt || caption || out).replace(/\s+/g, " ").slice(0, 400);

  return Response.json({ caption, prompt: `${scene} ${STYLE}` });
}

/**
 * Рисование через новый OpenAI-совместимый API Яндекса (картинка приходит сразу в ответе).
 * Пробуем по очереди модели и способы авторизации, пока не получится; запоминаем рабочий вариант.
 */
const MODELS = ["aliceai-image-art-3.0", "yandex-art-2.0/latest", "yandex-art/latest"];
let working: { model: string; auth: string } | null = null;

async function drawImage(c: { key: string; folder: string }, prompt: string) {
  const all = MODELS.flatMap((model) => [{ model, auth: `Api-Key ${c.key}` }, { model, auth: `Bearer ${c.key}` }]);
  const w = working;
  const combos = w ? [w, ...all.filter((x) => x.model !== w.model || x.auth !== w.auth)] : all;
  const errors: string[] = [];
  for (const combo of combos) {
    for (const size of ["1536x1024", "1024x1024"]) {
      const r = await fetch("https://ai.api.cloud.yandex.net/v1/images/generations", {
        method: "POST",
        headers: { Authorization: combo.auth, "OpenAI-Project": c.folder, "Content-Type": "application/json" },
        body: JSON.stringify({ model: `art://${c.folder}/${combo.model}`, prompt: prompt.slice(0, 1000), size }),
      });
      const text = await r.text();
      if (r.ok) {
        let j: any = {};
        try { j = JSON.parse(text); } catch {}
        const image = j?.data?.[0]?.b64_json;
        if (image) {
          working = combo;
          console.log("Image generated with", combo.model, combo.auth.split(" ")[0], size);
          return { image };
        }
        errors.push(`${combo.model}: пустой ответ`);
        break;
      }
      errors.push(`${combo.model} [${combo.auth.split(" ")[0]}, ${size}] ${r.status}: ${text.slice(0, 160)}`);
      if (r.status !== 400) break; // размер пробуем менять только при ошибке формата
    }
  }
  working = null;
  console.error("Image generation failed:", errors.join(" | "));
  return { error: errors.join(" | ").slice(0, 900) };
}

/** PUT /api/scene  { prompt } → { image } | { error } — само рисование */
export async function PUT(req: Request) {
  const c = config();
  if (!c) return Response.json({ error: "not_configured" }, { status: 501 });
  if (!(await authorize(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { prompt } = await req.json();
  if (!prompt || typeof prompt !== "string") return Response.json({ error: "no_prompt" }, { status: 400 });
  return Response.json(await drawImage(c, prompt));
}

export async function GET(req: Request) {
  const c = config();
  if (!c) return Response.json({ error: "not_configured" }, { status: 501 });
  if (!(await authorize(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const op = new URL(req.url).searchParams.get("op");
  if (!op || !/^[\w-]+$/.test(op)) return Response.json({ error: "bad_op" }, { status: 400 });
  const r = await fetch(`${API}/operations/${op}`, { headers: headers(c) });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    console.error("YandexART poll failed", r.status, detail);
    return Response.json({ done: true, error: `${r.status}: ${detail}` });
  }
  const j = await r.json();
  if (j.error) {
    console.error("YandexART generation error", JSON.stringify(j.error));
    return Response.json({ done: true, error: j.error.message ?? "generation_failed" });
  }
  if (!j.done) return Response.json({ done: false });
  return Response.json({ done: true, image: j.response?.image ?? null });
}
