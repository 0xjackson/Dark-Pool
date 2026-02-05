/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0a0014',      // Deep space purple/black background
          surface: '#1a0b2e', // Dark purple surface
          elevated: '#2d1b4e', // Elevated purple cards
        },
        purple: {
          primary: '#7c3aed',   // Vibrant purple (violet-600)
          secondary: '#a78bfa', // Light purple (violet-400)
          accent: '#c084fc',    // Pink-purple accent
          glow: '#9333ea',      // Glow effect purple
        },
        pool: {
          light: '#e9d5ff',     // Light liquid (violet-200)
          medium: '#c084fc',    // Medium liquid
          dark: '#7c3aed',      // Dark liquid
        }
      }
    },
  },
  plugins: [],
}
