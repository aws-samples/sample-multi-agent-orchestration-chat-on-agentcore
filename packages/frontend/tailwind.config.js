/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: {
          50: '#f9fafb',
          100: '#f3f4f6',
          200: '#e5e7eb',
          300: '#d1d5db',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1f2937',
          900: '#111827',
        },
        // Semantic color tokens via CSS custom properties
        brand: {
          DEFAULT: 'var(--color-brand)',
          light: 'var(--color-brand-light)',
          dark: 'var(--color-brand-dark)',
          accent: 'var(--color-brand-accent)',
          fg: 'var(--color-brand-fg)',
        },
        action: {
          primary: {
            DEFAULT: 'var(--color-action-primary)',
            hover: 'var(--color-action-primary-hover)',
            fg: 'var(--color-action-primary-fg)',
          },
          danger: {
            DEFAULT: 'var(--color-action-danger)',
            hover: 'var(--color-action-danger-hover)',
            fg: 'var(--color-action-danger-fg)',
            light: 'var(--color-action-danger-light)',
          },
          success: {
            DEFAULT: 'var(--color-action-success)',
            fg: 'var(--color-action-success-fg)',
          },
        },
        surface: {
          primary: 'var(--color-surface-primary)',
          secondary: 'var(--color-surface-secondary)',
          elevated: 'var(--color-surface-elevated)',
          overlay: 'var(--color-surface-overlay)',
        },
        border: {
          DEFAULT: 'var(--color-border-default)',
          strong: 'var(--color-border-strong)',
          focus: 'var(--color-border-focus)',
        },
        fg: {
          DEFAULT: 'var(--color-fg-default)',
          secondary: 'var(--color-fg-secondary)',
          muted: 'var(--color-fg-muted)',
          disabled: 'var(--color-fg-disabled)',
          inverse: 'var(--color-fg-inverse)',
          link: 'var(--color-fg-link)',
        },
        feedback: {
          error: {
            DEFAULT: 'var(--color-feedback-error)',
            bg: 'var(--color-feedback-error-bg)',
            border: 'var(--color-feedback-error-border)',
          },
          success: {
            DEFAULT: 'var(--color-feedback-success)',
            bg: 'var(--color-feedback-success-bg)',
            border: 'var(--color-feedback-success-border)',
          },
          warning: {
            DEFAULT: 'var(--color-feedback-warning)',
            bg: 'var(--color-feedback-warning-bg)',
            border: 'var(--color-feedback-warning-border)',
          },
          info: {
            DEFAULT: 'var(--color-feedback-info)',
            bg: 'var(--color-feedback-info-bg)',
            border: 'var(--color-feedback-info-border)',
          },
        },
      },
      fontFamily: {
        sans: ['"M PLUS Rounded 1c"', 'ui-rounded', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        // Semantic radius tokens
        btn: 'var(--radius-btn)',
        input: 'var(--radius-input)',
        card: 'var(--radius-card)',
        'card-lg': 'var(--radius-card-lg)',
        modal: 'var(--radius-modal)',
        pill: '9999px',
        xl: '0.75rem',
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      spacing: {
        // Semantic spacing tokens
        page: 'var(--spacing-page)',
        section: 'var(--spacing-section)',
        'card-pad': 'var(--spacing-card)',
        'card-pad-lg': 'var(--spacing-card-lg)',
      },
      boxShadow: {
        'elevation-1': '0 1px 2px rgba(0, 0, 0, 0.05)',
        'elevation-2': '0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06)',
        'elevation-3': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        'elevation-4': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
      },
      animation: {
        'subtle-fade-in': 'subtle-fade-in 0.2s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        'subtle-fade-in': {
          '0%': { opacity: '0.5' },
          '100%': { opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
