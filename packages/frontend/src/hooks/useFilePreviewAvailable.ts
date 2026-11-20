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

/**
 * Whether the dock is on screen. Not just `isOpen`: that is a persisted
 * preference, and toggling it while the dock is hidden would look like a
 * no-op click.
 */
export function useFilePreviewDockVisible(): boolean {
  const available = useFilePreviewAvailable();
  return useFilePreviewStore(
    (s) => s.isOpen && (s.path !== null || (s.emptyRequested && available))
  );
}
