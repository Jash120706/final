/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        blue: {
          50: '#F0F4FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          300: '#93C5FD',
          400: '#60A5FA',
          500: '#3B82F6',
          600: '#2563EB', // Solid deep blue primary
          700: '#1D4ED8', // Hover darken
          800: '#1E40AF',
          900: '#1E3A8A', // Deep indigo/blue
          950: '#172554',
        },
        slate: {
          50: '#F3F4F6', // Light gray fill (#F3F4F6-ish) for inputs
          100: '#F3F4F6', // Light gray fill
          200: '#E5E7EB', // Thin light-gray border
          300: '#D1D5DB',
          400: '#9CA3AF', // Muted gray
          500: '#6B7280', // Medium gray for body/subtext
          600: '#4B5563', // Medium gray
          700: '#374151',
          800: '#1F2937',
          900: '#0F1E3D', // Bold dark navy for headings
          950: '#050B14', // Very dark navy
        },
        brand: {
          blue: {
            50: '#F0F4FF',
            100: '#E0E7FF',
            500: '#3B82F6',
            600: '#2563EB',
            700: '#1D4ED8',
          },
          green: {
            50: '#F0FDF4',
            100: '#DCFCE7',
            500: '#22C55E',
            600: '#16A34A',
            700: '#15803D',
          },
          orange: {
            50: '#FFF7ED',
            100: '#FFEDD5',
            500: '#F97316',
            600: '#EA580C',
            700: '#C2410C',
          }
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        'lg': '8px',     // 8px
        'xl': '10px',    // 10px (for inputs/buttons)
        '2xl': '12px',   // 12px (for cards)
        '3xl': '16px',   // 16px (for cards/outer panels)
      },
      boxShadow: {
        'sm': '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        'DEFAULT': '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05)',
        'md': '0 4px 6px -1px rgba(0, 0, 0, 0.04), 0 2px 4px -2px rgba(0, 0, 0, 0.04)',
        'lg': '0 10px 15px -3px rgba(0, 0, 0, 0.04), 0 4px 6px -4px rgba(0, 0, 0, 0.04)',
        'xl': '0 20px 25px -5px rgba(0, 0, 0, 0.03), 0 8px 10px -6px rgba(0, 0, 0, 0.03)',
        '2xl': '0 25px 50px -12px rgba(0, 0, 0, 0.025)',
      }
    },
  },
  plugins: [],
}
