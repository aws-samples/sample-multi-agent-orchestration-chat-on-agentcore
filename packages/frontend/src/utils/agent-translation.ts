/**
 * Agent Translation Utilities
 * Helper functions for translating Agent data in translation-key format to the current language
 */

import type { TFunction } from 'i18next';
import type { Agent, Scenario } from '../types/agent';

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

/**
 * Translate display text for a Scenario
 *
 * @param scenario - The Scenario to translate
 * @param t - i18next translation function
 * @returns Translated Scenario
 */
export const translateScenario = (scenario: Scenario, t: TFunction): Scenario => {
  return {
    ...scenario,
    title: translateIfKey(scenario.title, t),
    prompt: translateIfKey(scenario.prompt, t),
  };
};

/**
 * Translate display text for an Agent
 * Converts translation keys for name, description, and scenarios to the current language
 * systemPrompt is not translated (kept as real text)
 *
 * @param agent - The Agent to translate
 * @param t - i18next translation function
 * @returns Translated Agent
 */
export const translateAgent = (agent: Agent, t: TFunction): Agent => {
  return {
    ...agent,
    name: translateIfKey(agent.name, t),
    description: translateIfKey(agent.description, t),
    scenarios: agent.scenarios.map((scenario) => translateScenario(scenario, t)),
  };
};

/**
 * Translate display text for an Agent array
 *
 * @param agents - The Agent array to translate
 * @param t - i18next translation function
 * @returns Translated Agent array
 */
export const translateAgents = (agents: Agent[], t: TFunction): Agent[] => {
  return agents.map((agent) => translateAgent(agent, t));
};
