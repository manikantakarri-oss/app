import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "media",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#18181b", dim: "#52525b", faint: "#71717a" },
        line: "#e4e4e7",
        surface: "#ffffff",
        canvas: "#f8f8f9",
        brand: { DEFAULT: "#2f6df6", ink: "#ffffff", soft: "#eaf0fe" },
      },
      borderRadius: { xl2: "14px" },
      // One step larger than Tailwind's defaults across the whole portal: hints
      // and secondary text were 12px, which is hard to read for anyone not
      // staring at software all day. Bumping the scale lifts every screen at once.
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.25rem" }],
        sm: ["0.9375rem", { lineHeight: "1.5rem" }],
      },
    },
  },
  plugins: [],
};
export default config;
