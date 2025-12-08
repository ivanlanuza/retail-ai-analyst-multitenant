// tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
    "./app/**/*.{js,jsx}", // safe even if you don't use App Router
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
