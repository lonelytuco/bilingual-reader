"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function Auth() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === "in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg(translate(error.message));
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) setMsg(translate(error.message));
      else if (!data.session)
        setMsg("Готово! Проверь почту и нажми на ссылку в письме, затем войди здесь.");
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="serif mb-1 text-4xl">Две книги</h1>
      <p className="mb-8 text-muted">Одна книга на двух языках. Позиция — на всех устройствах.</p>
      <form onSubmit={submit} className="space-y-3">
        <input className="input" type="email" placeholder="Email" autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="input" type="password" placeholder="Пароль (от 6 символов)"
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        <button className="btn-primary w-full py-3" disabled={busy}>
          {busy ? "…" : mode === "in" ? "Войти" : "Создать аккаунт"}
        </button>
      </form>
      {msg && <p className="mt-4 text-sm text-accent">{msg}</p>}
      <button className="mt-6 text-sm text-muted underline"
        onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}>
        {mode === "in" ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
      </button>
    </main>
  );
}

function translate(m: string) {
  if (/Invalid login/i.test(m)) return "Неверный email или пароль.";
  if (/Email not confirmed/i.test(m)) return "Сначала подтверди email — ссылка в письме.";
  if (/already registered/i.test(m)) return "Такой email уже зарегистрирован — просто войди.";
  return m;
}
