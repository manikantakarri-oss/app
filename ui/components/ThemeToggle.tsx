"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "./icons";

type Choice = "light" | "dark";
const KEY = "agent-portal-theme";

/** Writes the choice onto <html>. */
export function applyTheme(choice: Choice) {
  document.documentElement.setAttribute("data-theme", choice);
}

/** What the OS asks for. Used only until the person picks one themselves. */
function osChoice(): Choice {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function stored(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
    // Anything else, including a "system" saved by an earlier version, means
    // "no explicit choice yet", so follow the OS.
  } catch {
    // Private windows and blocked site data both throw here; the OS setting is
    // a fine answer in that case.
  }
  return osChoice();
}

const LABEL: Record<Choice, string> = { light: "Light", dark: "Dark" };

export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("light");

  // Read on mount rather than during render: the value only exists in the
  // browser, and this component is inside a static export.
  useEffect(() => {
    setChoice(stored());
  }, []);

  function next() {
    const pick: Choice = choice === "light" ? "dark" : "light";
    setChoice(pick);
    applyTheme(pick);
    try {
      localStorage.setItem(KEY, pick);
    } catch {
      // Not being able to remember the choice is not worth an error; it just
      // resets on the next visit.
    }
  }

  return (
    <button
      type="button"
      onClick={next}
      className="icon-btn !h-10 !w-10"
      title={`Appearance: ${LABEL[choice]}. Click to switch to ${LABEL[choice === "light" ? "dark" : "light"]}.`}
      aria-label={`Appearance: ${LABEL[choice]}. Click to switch.`}
    >
      {choice === "light" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
    </button>
  );
}
