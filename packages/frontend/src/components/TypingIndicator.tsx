import React from 'react';

/**
 * Animated indicator that displays while a message is being typed
 */
export const TypingIndicator: React.FC = () => {
  return (
    <div className="text-fg-muted italic pt-2">
      <div className="flex items-center text-fg-muted">
        <div className="flex space-x-1">
          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
          <div
            className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
            style={{ animationDelay: '0.1s' }}
          ></div>
          <div
            className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
            style={{ animationDelay: '0.2s' }}
          ></div>
        </div>
      </div>
    </div>
  );
};
