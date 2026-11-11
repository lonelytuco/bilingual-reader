"use client";
import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
export const THEMES: { id: Theme; name: string }[] = [
  { id: "system", name: "Системная" },
  { id: "light", name: "Светлая" },
  { id: "dark", name: "Тёмная" },
];

function read(): Theme {
  try {
    const t = localStorage.getItem("theme");
    if (t === "light" || t === "dark" || t === "system") return t;
  } catch {}
  return "system";
}

const listeners = new Set<() => void>();

export function setTheme(t: Theme) {
  try { localStorage.setItem("theme", t); } catch {}
  document.documentElement.dataset.theme = t;
  listeners.forEach((f) => f());
}

/** Возвращает [выбранная тема, итог: тёмная или нет] и следит за системной настройкой */
export function useTheme(): [Theme, boolean] {
  const [theme, set] = useState<Theme>("system");
  const [sysDark, setSysDark] = useState(false);
  useEffect(() => {
    set(read());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSysDark(mq.matches);
    const onMq = () => setSysDark(mq.matches);
    const onSet = () => set(read());
    mq.addEventListener("change", onMq);
    listeners.add(onSet);
    return () => { mq.removeEventListener("change", onMq); listeners.delete(onSet); };
  }, []);
  return [theme, theme === "dark" || (theme === "system" && sysDark)];
}

export const READER_COLORS = {
  light: { bg: "#f7f3ec", fg: "#23201b", link: "#b5532c" },
  dark: { bg: "#161513", fg: "#d9d3c7", link: "#e08a5f" },
};
