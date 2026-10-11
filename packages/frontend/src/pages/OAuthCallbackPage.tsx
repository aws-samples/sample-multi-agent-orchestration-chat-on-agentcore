/**
 * /oauth/callback — return URL for Gateway 3LO targets.
 *
 * AgentCore Identity redirects here with `?session_id=<request_uri>` after the
 * user consents. The backend completes the session binding with this user's
 * JWT, so a link started by someone else cannot be completed here.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { completeOAuthAuthorization } from '../api/oauth';
import { Alert } from '../components/ui/Alert';
import { LoadingIndicator } from '../components/ui/LoadingIndicator';
import { OAUTH_BROADCAST_CHANNEL, takeOAuthReturnPath } from '../lib/oauth-authorization';

type Status = 'processing' | 'success' | 'failed' | 'missingSession';

export function OAuthCallbackPage() {
  const { t } = useTranslation();
  const [sessionUri] = useState(() =>
    new URLSearchParams(window.location.search).get('session_id')
  );
  const [status, setStatus] = useState<Status>(sessionUri ? 'processing' : 'missingSession');
  const [returnPath] = useState(takeOAuthReturnPath);
  // StrictMode runs effects twice; the session URI is single-use.
  const started = useRef(false);

  useEffect(() => {
    // Drop the single-use session URI from the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    if (!sessionUri || started.current) return;
    started.current = true;

    completeOAuthAuthorization(sessionUri)
      .then(() => {
        setStatus('success');
        if (typeof BroadcastChannel !== 'undefined') {
          const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
          channel.postMessage({ type: 'completed' });
          channel.close();
        }
      })
      .catch(() => setStatus('failed'));
  }, [sessionUri]);

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold text-fg-default">{t('oauth.callback.title')}</h1>
        {status === 'processing' ? (
          <div className="flex items-center gap-3 text-sm text-fg-secondary">
            <LoadingIndicator size="sm" />
            {t('oauth.callback.processing')}
          </div>
        ) : (
          <Alert variant={status === 'success' ? 'success' : 'error'}>
            {t(`oauth.callback.${status}`)}
          </Alert>
        )}
        {status !== 'processing' && (
          <Link
            to={returnPath}
            className="inline-block text-sm text-action-primary hover:underline"
          >
            {t('oauth.callback.backToChat')}
          </Link>
        )}
      </div>
    </div>
  );
}
