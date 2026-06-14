/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      colors: {
        ink: {
          950: '#0a0a0f',
          900: '#0e0e16',
          850: '#13131f',
          800: '#1a1a28',
          700: '#252538',
          600: '#33334d',
        },
        brand: {
          DEFAULT: '#7c5cff',
          glow: '#9d83ff',
          dim: '#5b43c0',
        },
        accent: '#22d3ee',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(124,92,255,0.4), 0 8px 40px -8px rgba(124,92,255,0.45)',
      },
    },
  },
  plugins: [],
};
