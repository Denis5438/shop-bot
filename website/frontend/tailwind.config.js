/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0A0D14',
          card: '#121624',
          cardHover: '#181E30',
          surface: '#1A2035',
          border: '#222A42',
          borderHighlight: '#323E60',
          input: '#0E121E',
        },
        brand: {
          DEFAULT: '#FF5722',
          hover: '#F4511E',
          glow: 'rgba(255, 87, 34, 0.25)',
          muted: '#8A3B22',
        },
        status: {
          success: '#10B981',
          danger: '#EF4444',
          warning: '#F59E0B',
          info: '#3B82F6',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
