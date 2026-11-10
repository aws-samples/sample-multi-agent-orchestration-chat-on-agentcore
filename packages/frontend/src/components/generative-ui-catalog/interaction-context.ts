import { createContext, useContext } from 'react';

/**
 * Whether interactive generative UI (e.g. SuggestedReplies) may send messages.
 * Only the latest message of an idle session is interactive — choices in older
 * messages would answer a question the conversation has already moved past.
 */
export const GenerativeUiInteractionContext = createContext<{ interactive: boolean }>({
  interactive: false,
});

export const useGenerativeUiInteraction = () => useContext(GenerativeUiInteractionContext);
