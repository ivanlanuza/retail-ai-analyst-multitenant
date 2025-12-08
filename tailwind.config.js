// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
    "./app/**/*.{js,jsx}", // safe even if you don't use App Router
  ],
  theme: {
    extend: {
      fontFamily: {
        // Geist Sans as the default sans
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        // Geist Mono as the default mono
        mono: ["var(--font-geist-mono)", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};
