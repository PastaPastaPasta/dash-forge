/** @type {import('tailwindcss').Config} */
// Design tokens are the single source of truth from docs/design/style-guide.md §A.
// "Foundry, not startup SaaS": warm dark metals + ember accent, zero decorative gradients.
// Dark mode is the PRIMARY theme (class-based, driven by next-themes).
module.exports = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        forge: {
          // ember/molten accent ramp (primary)
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
          950: '#431407',
        },
        anvil: {
          // neutral ramp, warm-tinted grays (bg/surfaces/text)
          50: '#fafaf9',
          100: '#f5f5f4',
          200: '#e7e5e4',
          300: '#d6d3d1',
          400: '#a8a29e',
          500: '#78716c',
          600: '#57534e',
          700: '#44403c',
          750: '#3a3835',
          800: '#292524',
          850: '#211e1c',
          900: '#1c1917',
          950: '#0f0d0c',
        },
        // Semantic colors are MEANINGFUL, never decorative. Do not repurpose.
        verify: {
          DEFAULT: '#16a34a', // proof/hash verified — icons, borders, tints
          700: '#15803d', // solid fill behind white text (5.02:1; the base value is 3.3:1)
        },
        caution: '#d97706', // degraded availability
        danger: '#dc2626', // force-push, delete, failed verification
        // Dash brand blue — identity/credits/network UI only. The brand value is for fills,
        // tints and icons; it is under 4.5:1 as TEXT on every surface in both themes, so
        // text uses the WCAG AA shades: `text-dash-600 dark:text-dash-400` (the same
        // light/dark pairing forge text uses). lib/design/contrast.test.ts pins the ratios.
        dash: {
          DEFAULT: '#008de4',
          400: '#4aaef0', // text on dark surfaces (anvil-950…800)
          600: '#006bb0', // text on light surfaces (white, anvil-50/100)
          700: '#005a94', // solid fill behind white text (7.27:1; the brand value is 3.54:1)
        },
      },
      fontFamily: {
        // UI: system stack — fast, no font payload.
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        // Code/OIDs/hashes/CIDs: monospace is a first-class citizen.
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'JetBrains Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        // 13px base for dense surfaces (file lists, commit log); 15px for prose.
        dense: ['0.8125rem', { lineHeight: '1.25rem' }],
        prose: ['0.9375rem', { lineHeight: '1.5rem' }],
      },
      // Motion: 150ms ease-out enter/fade only. No scroll-jacking, no shimmer.
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
