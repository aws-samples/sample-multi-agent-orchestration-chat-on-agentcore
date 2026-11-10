/**
 * Window events that let components outside MessageInput drive the chat input
 * (e.g. generative UI reply choices). A window event is used instead of a store
 * because MessageInput owns the draft text, attachments and submit flow locally.
 */

export const MESSAGE_INPUT_SUBMIT_EVENT = 'submitMessageInput';
export const MESSAGE_INPUT_FOCUS_EVENT = 'focusMessageInput';

export interface MessageInputSubmitDetail {
  text: string;
}

/**
 * Send `text` as a user message without touching the draft in the input.
 * Returns true only if MessageInput accepted it (it calls preventDefault()) —
 * it refuses while a turn or the agent list is loading, so callers must not
 * assume the message went out.
 */
export function submitMessageInput(text: string): boolean {
  const event = new CustomEvent<MessageInputSubmitDetail>(MESSAGE_INPUT_SUBMIT_EVENT, {
    detail: { text },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}

/** Focus the chat input (keeps any draft) so the user can type a free-form answer. */
export function focusMessageInput(): void {
  window.dispatchEvent(new CustomEvent(MESSAGE_INPUT_FOCUS_EVENT));
}
