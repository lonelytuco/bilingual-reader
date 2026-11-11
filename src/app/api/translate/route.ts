// Перевод через Claude — работает, только если в Vercel задана переменная ANTHROPIC_API_KEY.
// Без ключа отвечает 501, и сайт сам переключается на бесплатный MyMemory.
export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "not configured" }, { status: 501 });
  const { text, from, to } = await req.json();
  if (!text || typeof text !== "string") return Response.json({ error: "no text" }, { status: 400 });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
      max_tokens: 1024,
      system: `Translate the user's text from ${from} to ${to}, as a published literary translation would. Output only the translation.`,
      messages: [{ role: "user", content: text.slice(0, 1500) }],
    }),
  });
  if (!r.ok) return Response.json({ error: await r.text() }, { status: 502 });
  const j = await r.json();
  return Response.json({ text: j?.content?.[0]?.text ?? "" });
}
