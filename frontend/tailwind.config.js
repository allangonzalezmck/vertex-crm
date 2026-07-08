/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        primary: 'var(--color-primary)',
        surface: {
          1: 'var(--color-surface-1)',
          2: 'var(--color-surface-2)',
        },
        border: 'var(--color-border)',
        fg: 'var(--color-fg)',
        'muted-fg': 'var(--color-muted-fg)',
      },
    },
  },
  plugins: [],
};
