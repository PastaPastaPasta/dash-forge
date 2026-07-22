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
        verify: '#16a34a', // proof/hash verified
        caution: '#d97706', // degraded availability
        danger: '#dc2626', // force-push, delete, failed verification
        dash: '#008de4', // Dash brand blue — identity/credits/network UI only
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
