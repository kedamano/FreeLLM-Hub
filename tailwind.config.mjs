/** @type {import('tailwindcss').Config} */
// Design language derived from matrix.mzsjai.com's own CSS tokens:
// azure-blue primary (oklch 55% .2 255 = #006de2), cool near-white surfaces,
// white cards, soft 10-16px radii, Sora + Noto Sans SC type stack.
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#EEF6FF',
          100: '#D9ECFF',
          200: '#BCE0FF',
          300: '#8ECBFF',
          400: '#4D9DFF',
          500: '#147EF0',
          600: '#006DE2', // brand azure — buttons, links, active states
          700: '#0057C4',
          800: '#03479B',
          900: '#0A3D7F',
        },
        surface: {
          50: '#F9FAFB', // app background
          100: '#F1F4F8',
          200: '#DADEE5', // borders
          300: '#C7CCD4',
          400: '#9AA2AD', // placeholders
          500: '#6B7280',
          600: '#5D646F', // muted foreground
          700: '#474D57',
          800: '#2B3038',
          900: '#030712', // primary text
        },
        accent: {
          teal: '#00B089',
          violet: '#A84CDF',
          rose: '#DE3B3D',
          amber: '#EE9733',
        },
        success: '#00B089',
        warning: '#EE9733',
        error: '#DE3B3D',
        info: '#006DE2',
      },
      fontFamily: {
        // Sora is self-hosted (assets/fonts) so it works offline and under CSP.
        sans: ['Sora', '"Noto Sans SC"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Consolas', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
        'card-hover': '0 8px 24px -6px rgba(0,109,226,0.12), 0 2px 6px rgba(16,24,40,0.06)',
        'inset-line': 'inset 0 -1px 0 rgba(16,24,40,0.06)',
        pop: '0 12px 32px -8px rgba(16,24,40,0.18)',
      },
      borderRadius: {
        card: '16px',
        field: '10px',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
};
