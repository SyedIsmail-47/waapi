/** @type {import("tailwindcss").Config} */
export default {
  content: ["./scripts/**/*.{js,mjs}", "./dist/**/*.html"],
  theme: {
    extend: {
      colors: {
        ink: "#14201a",
        muted: "#5c6b63",
        paper: "#f3f6f2",
        panel: "#ffffff",
        line: "#d5ddd7",
        accent: "#1f7a4c",
        warn: "#9a5b12",
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        display: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
