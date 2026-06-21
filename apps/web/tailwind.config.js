/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // All grays/indigoes use CSS-var channels so runtime themes work.
        // Defaults (Grafana Dark) are defined in :root inside index.css.
        gray: {
          950: 'rgb(var(--g950) / <alpha-value>)',
          900: 'rgb(var(--g900) / <alpha-value>)',
          800: 'rgb(var(--g800) / <alpha-value>)',
          700: 'rgb(var(--g700) / <alpha-value>)',
          600: 'rgb(var(--g600) / <alpha-value>)',
          500: 'rgb(var(--g500) / <alpha-value>)',
          400: 'rgb(var(--g400) / <alpha-value>)',
          300: 'rgb(var(--g300) / <alpha-value>)',
          200: 'rgb(var(--g200) / <alpha-value>)',
          100: 'rgb(var(--g100) / <alpha-value>)',
          50:  'rgb(var(--g50)  / <alpha-value>)',
        },
        indigo: {
          600: 'rgb(var(--accent) / <alpha-value>)',
          500: 'rgb(var(--accent) / <alpha-value>)',
          400: 'rgb(var(--accent-lite) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'panel': '0 1px 3px rgba(0,0,0,0.4)',
        'modal': '0 8px 32px rgba(0,0,0,0.6)',
        'input': '0 0 0 2px rgba(var(--accent) / 0.3)',
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
