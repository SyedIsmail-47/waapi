import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "var(--ink)",
        muted: "var(--muted)",
        paper: "var(--paper)",
        panel: "var(--panel)",
        line: "var(--line)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        warn: "var(--warn)",
        border: "var(--line)",
        background: "var(--paper)",
        foreground: "var(--ink)",
        primary: {
          DEFAULT: "var(--accent)",
          foreground: "#ffffff",
        },
        card: {
          DEFAULT: "var(--panel)",
          foreground: "var(--ink)",
        },
        destructive: {
          DEFAULT: "#b42318",
          foreground: "#ffffff",
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "sans-serif"],
        display: ["Fraunces", "Georgia", "serif"],
      },
      borderRadius: {
        lg: "0",
        md: "0",
        sm: "0",
      },
    },
  },
  plugins: [],
} satisfies Config;
