/**
 * Gateway 3LO authorization prompts for the active session.
 *
 * The link comes from a stream event (never from model text) and is
 * host-checked before reaching the store. See docs/adr/gateway-3lo-github.md.
 */

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { useChatStore } from '../stores/chatStore';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { cn } from '../lib/utils';
import {
  OAUTH_BROADCAST_CHANNEL,
  rememberOAuthReturnPath,
  serviceNameOf,
} from '../lib/oauth-authorization';

interface AuthorizationPromptsProps {
  sessionId?: string | null;
  className?: string;
}

export const AuthorizationPrompts: React.FC<AuthorizationPromptsProps> = ({
  sessionId,
  className,
}) => {
  const { t } = useTranslation();
  const prompts = useChatStore((state) =>
    sessionId ? state.sessions[sessionId]?.pendingAuthorizations : undefined
  );
  const dismiss = useChatStore((state) => state.dismissAuthorizationPrompts);

  // The callback page runs in another tab; it reports completion here.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== 'completed') return;
      const state = useChatStore.getState();
      for (const session of Object.values(state.sessions)) {
        for (const prompt of session.pendingAuthorizations ?? []) {
          state.dismissAuthorizationPrompts(prompt.targetName);
        }
      }
    };
    return () => channel.close();
  }, []);

  if (!sessionId || !prompts?.length) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {prompts.map((prompt) => {
        const service = serviceNameOf(prompt.targetName);
        return (
          <Alert
            key={prompt.targetName}
            variant="info"
            title={t('oauth.prompt.title', { service })}
            onDismiss={() => dismiss(prompt.targetName, sessionId)}
          >
            <p className="mb-2">{t('oauth.prompt.description', { service })}</p>
            <Button
              size="sm"
              variant="primary"
              rightIcon={ExternalLink}
              onClick={() => {
                rememberOAuthReturnPath(sessionId);
                window.open(prompt.url, '_blank', 'noopener,noreferrer');
              }}
            >
              {t('oauth.prompt.connect', { service })}
            </Button>
          </Alert>
        );
      })}
    </div>
  );
};
