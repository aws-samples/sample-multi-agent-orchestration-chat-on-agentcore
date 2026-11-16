/**
 * Agent Translation Utilities
 * Helper functions for translating Agent data in translation-key format to the current language
 */

import type { TFunction } from 'i18next';

/**
 * Determine whether the text is a translation key
 * Strings starting with "defaultAgents." are treated as translation keys
 */
export const isTranslationKey = (text: string): boolean => {
  return text.startsWith('defaultAgents.');
};

/**
 * Apply translation if the text is a translation key, otherwise return as-is
 *
 * @param text - The text to translate (translation key or plain text)
 * @param t - i18next translation function
 * @returns Translated text, or the original text
 */
export const translateIfKey = (text: string, t: TFunction): string => {
  if (!text || typeof text !== 'string') {
    return text;
  }

  if (isTranslationKey(text)) {
    const translated = t(text);
    // If the translation is not found, the key itself is returned, so return the original text in that case
    return translated === text ? text : translated;
  }

  return text;
};
