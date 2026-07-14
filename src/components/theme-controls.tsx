"use client";

import { Moon, SunMedium } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "dark" | "light";

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = document.cookie.match(/(?:^|; )theme=([^;]+)/)?.[1] as Theme | undefined;
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    setCookie("theme", next);
  }

  return (
    <button className="icon-button" type="button" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
      {theme === "dark" ? <Moon size={17} /> : <SunMedium size={17} />}
    </button>
  );
}

export type TradeMode = "simple" | "pro";

export function applyTradeMode(mode: TradeMode) {
  // Pro mode adopts the dense terminal presentation; Simple keeps balanced rows.
  document.documentElement.dataset.density = mode === "pro" ? "pro" : "balanced";
  setCookie("mode", mode);
}

export function ModeToggle({ mode, onModeChange }: { mode: TradeMode; onModeChange: (mode: TradeMode) => void }) {
  function set(next: TradeMode) {
    if (next === mode) return;
    applyTradeMode(next);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", next);
    window.history.replaceState(null, "", url.toString());
    onModeChange(next);
  }

  return (
    <div className="segmented" aria-label="Trading mode">
      <button className={mode === "simple" ? "active" : ""} type="button" onClick={() => set("simple")}>
        Simple
      </button>
      <button className={mode === "pro" ? "active" : ""} type="button" onClick={() => set("pro")}>
        Pro
      </button>
    </div>
  );
}

