import { useMemo } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useFilePreviewStore } from '../stores/filePreviewStore';
import { hasInAppFileLink } from '../utils/fileLinks';

/**
 * Whether the preview dock has anything to offer: a file is loaded, or the
 * open conversation links to one. Derived from the messages rather than from
 * mounted links, so it does not flicker while the list re-renders.
 */
export function useFilePreviewAvailable(): boolean {
  const hasFile = useFilePreviewStore((s) => s.path !== null);
  const messages = useChatStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId]?.messages : undefined
  );
  const hasLinks = useMemo(
    () =>
      !!messages?.some((m) =>
        m.contents.some((c) => c.type === 'text' && !!c.text && hasInAppFileLink(c.text))
      ),
    [messages]
  );
  return hasFile || hasLinks;
}
