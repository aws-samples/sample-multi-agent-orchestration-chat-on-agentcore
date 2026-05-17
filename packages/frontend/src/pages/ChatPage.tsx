import { ChatContainer } from '../components/ChatContainer';
import { useSessionSync } from '../hooks/useSessionSync';
import { useAgentFromUrl } from '../hooks/useAgentFromUrl';

/**
 * Chat Page
 * - /chat: New chat (no sessionId)
 * - /chat/:sessionId: Continue existing session
 */
export function ChatPage() {
  const { currentSessionId, createAndNavigateToNewSession } = useSessionSync();
  const { selectAgentAndUpdateUrl, isAgentResolved } = useAgentFromUrl();

  return (
    <ChatContainer
      sessionId={currentSessionId}
      onCreateSession={createAndNavigateToNewSession}
      onAgentSelect={selectAgentAndUpdateUrl}
      isAgentResolved={isAgentResolved}
    />
  );
}
