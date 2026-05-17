import 'react-i18next';

// Enable TypeScript translation key completion
declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof import('../locales/ja.yaml');
    };
  }
}
