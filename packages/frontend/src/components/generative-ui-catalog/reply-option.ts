export interface ReplyOption {
  label: string;
  description?: string;
  value?: string;
}

/** Text sent as the user's reply: the explicit value, falling back to the label. */
export const replyText = (option: ReplyOption) => option.value?.trim() || option.label;
