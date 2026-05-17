/**
 * Skeleton placeholder for the welcome screen shown while the agent
 * selection is being resolved from the URL query parameter.
 *
 * Why: On reload the agentStore initialises from localStorage before
 * useAgentFromUrl has a chance to apply the URL's ?agent param.
 * Showing this skeleton prevents the brief flash of the wrong agent name.
 */

import React from 'react';

export const WelcomeScreenSkeleton: React.FC = () => (
  <div className="text-center py-12 animate-pulse">
    {/* Icon */}
    <div className="mx-auto w-16 h-16 bg-border rounded-2xl mb-4" />

    {/* Agent name */}
    <div className="h-8 bg-border rounded-lg w-48 mx-auto mb-3" />

    {/* Description lines */}
    <div className="h-4 bg-border rounded w-80 mx-auto mb-2" />
    <div className="h-4 bg-border rounded w-64 mx-auto mb-8" />

    {/* Scenario buttons */}
    <div className="grid grid-cols-3 gap-3 max-w-2xl mx-auto">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-12 bg-border rounded-xl" />
      ))}
    </div>
  </div>
);
