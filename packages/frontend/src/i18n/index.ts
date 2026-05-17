import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { load } from 'js-yaml';

// Import translation files
import jaYaml from '../locales/ja.yaml?raw';
import enYaml from '../locales/en.yaml?raw';

// Parse YAML
const ja = load(jaYaml) as Record<string, unknown>;
const en = load(enYaml) as Record<string, unknown>;

// Initialize i18n
i18n
  .use(LanguageDetector) // Auto-detect browser language
  .use(initReactI18next) // Integrate with React
  .init({
    resources: {
      ja: {
        translation: ja,
      },
      en: {
        translation: en,
      },
    },
    fallbackLng: 'en', // Fallback language
    supportedLngs: ['ja', 'en'], // Supported languages
    debug: import.meta.env.DEV, // Enable debug logs in development mode

    interpolation: {
      escapeValue: false, // React already escapes by default
    },

    // Detect missing translation keys (dev mode only)
    saveMissing: import.meta.env.DEV,

    // Handler for missing keys
    missingKeyHandler: (lngs, ns, key, fallbackValue) => {
      if (import.meta.env.DEV) {
        // i18n is a foundation layer and cannot depend on utils/logger.
        // This branch only runs in development builds, so bypassing the logger
        // abstraction is safe — the production bundle never reaches this call.
        // eslint-disable-next-line no-console
        console.warn(
          '%c[i18n] Translation key not found: "%s"',
          'color: #ff9800; font-weight: bold',
          key,
          {
            languages: lngs,
            namespace: ns,
            fallbackValue,
          }
        );
      }
    },

    // Display key name as-is for missing keys (explicit default behavior)
    returnEmptyString: false,

    detection: {
      // Language detection priority
      order: ['localStorage', 'navigator'],
      // localStorage key name
      lookupLocalStorage: 'i18nextLng',
      // Languages to cache
      caches: ['localStorage'],
    },

    react: {
      useSuspense: false, // Disable Suspense (can enable if needed)
    },
  });

export default i18n;
