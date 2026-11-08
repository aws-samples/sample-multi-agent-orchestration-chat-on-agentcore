/**
 * Skeleton component for loading messages
 * Displays loading state during session switching
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingIndicator } from './ui/LoadingIndicator';

export const MessageSkeleton: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="animate-pulse space-y-6 p-4">
      {/* User message-style skeleton */}
      <div className="flex justify-end">
        <div className="bg-border rounded-2xl rounded-tr-md h-16 w-80 max-w-[70%]"></div>
      </div>

      {/* Assistant message-style skeleton */}
      <div className="flex justify-start">
        <div className="bg-surface-secondary rounded-2xl rounded-tl-md p-4 w-96 max-w-[80%] space-y-2">
          <div className="h-4 bg-border rounded w-full"></div>
          <div className="h-4 bg-border rounded w-5/6"></div>
          <div className="h-4 bg-border rounded w-4/6"></div>
        </div>
      </div>

      {/* Second user message-style skeleton */}
      <div className="flex justify-end">
        <div className="bg-border rounded-2xl rounded-tr-md h-12 w-64 max-w-[60%]"></div>
      </div>

      {/* Second assistant message-style skeleton */}
      <div className="flex justify-start">
        <div className="bg-surface-secondary rounded-2xl rounded-tl-md p-4 w-80 max-w-[75%] space-y-2">
          <div className="h-4 bg-border rounded w-full"></div>
          <div className="h-4 bg-border rounded w-3/4"></div>
        </div>
      </div>

      {/* Loading text */}
      <LoadingIndicator message={t('chat.loadingHistory')} />
    </div>
  );
};
