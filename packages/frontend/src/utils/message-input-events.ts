/**
 * Window event that lets components outside MessageInput send a chat message
 * (e.g. generative UI reply choices). A window event is used instead of a store
 * because MessageInput owns the draft text, attachments and submit flow locally.
 */

export const MESSAGE_INPUT_SUBMIT_EVENT = 'submitMessageInput';

export interface MessageInputSubmitDetail {
  text: string;
}

/** Put `text` into the chat input and send it. */
export function submitMessageInput(text: string): void {
  window.dispatchEvent(
    new CustomEvent<MessageInputSubmitDetail>(MESSAGE_INPUT_SUBMIT_EVENT, { detail: { text } })
  );
}

/** Focus the chat input (keeps any draft) so the user can type a free-form answer. */
export function focusMessageInput(): void {
  window.dispatchEvent(new CustomEvent('focusMessageInput'));
}
