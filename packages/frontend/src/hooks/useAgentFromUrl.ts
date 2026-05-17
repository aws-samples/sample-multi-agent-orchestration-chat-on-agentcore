/**
 * Hook to sync agent selection with URL query parameter (?agent=<agentId>)
 *
 * Responsibility:
 *   Two-way binding between the URL's ?agent query param and agentStore.selectedAgent.
 *   Nothing else. Session-driven agent switching is handled inside sessionStore.selectSession
 *   (which calls agentStore.selectAgent), and this hook's (B) effect automatically reflects
 *   that into the URL.
 *
 * Design:
 * - URL is the single source of truth for agent selection per tab
 * - (A) URL → store: when URL's ?agent changes, update store to match
 * - (B) store → URL: when selectedAgent changes, update URL to match
 *
 * Why this layering:
 *   Previously this hook also tried to let session.agentId override the URL, which collided
 *   with user-initiated agent switches (the URL update would be overwritten back to the
 *   session's agentId on the next effect run). All session→agent propagation now lives in
 *   sessionStore.selectSession, and the URL follows store changes via (B).
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAgentStore } from '../stores/agentStore';
import type { Agent } from '../types/agent';

export function useAgentFromUrl() {
  const [searchParams, setSearchParams] = useSearchParams();
  const agents = useAgentStore((state) => state.agents);
  const selectedAgent = useAgentStore((state) => state.selectedAgent);
  const selectAgent = useAgentStore((state) => state.selectAgent);

  /**
   * Whether the agent selection has been resolved from the URL.
   *
   * Derived from inputs this hook already has:
   *   - agents must be loaded, AND
   *   - the URL must carry an ?agent param (either user-supplied or just
   *     written by effect (A)/(B) below).
   *
   * Deriving (instead of tracking in useState + setState-in-effect) keeps the
   * value consistent with render inputs and avoids react-hooks/set-state-in-effect
   * violations. When effect (A) writes the URL in the "no ?agent" branch, the
   * resulting re-render flips this to true — matching the prior one-frame
   * delay semantics that existed to avoid flashing the wrong agent.
   */
  const isAgentResolved = agents.length > 0 && searchParams.has('agent');

  // (A) URL → store: reflect URL's ?agent into the store.
  //
  // This effect ONLY watches the URL and the agents list. It does NOT look at
  // sessionStore — session-driven agent switches are handled inside
  // sessionStore.selectSession() which calls agentStore.selectAgent() directly,
  // and effect (B) below picks that up and writes the URL.
  useEffect(() => {
    if (agents.length === 0) return;

    const agentIdFromUrl = searchParams.get('agent');

    if (agentIdFromUrl) {
      const agentInList = agents.find((a) => a.agentId === agentIdFromUrl);
      if (agentInList && agentInList.agentId !== selectedAgent?.agentId) {
        selectAgent(agentInList);
      }
    } else {
      // No ?agent param — seed the URL from the current selection (or fallback to first agent)
      // so reloading this tab restores the right agent.
      const agentToSet = selectedAgent ?? agents[0];
      if (agentToSet) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set('agent', agentToSet.agentId);
            return next;
          },
          { replace: true } // Don't pollute history for this initial sync
        );
        // setSearchParams triggers a re-render with the new ?agent param,
        // which will run this effect again and hit the branch above.
        // isAgentResolved is derived and automatically flips to true on that
        // re-render, avoiding a wrong-agent flash for one frame.
      }
    }
    // selectedAgent is intentionally excluded from deps: (B) handles the
    // selectedAgent→URL direction, and including it here would create a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, searchParams]);

  // (B) store → URL: reflect selectedAgent into the URL's ?agent.
  //
  // Handles every path that mutates selectedAgent (header selector, command
  // palette, session selection, agent creation/deletion, etc.) with a single
  // unified rule: "whatever is in selectedAgent wins the URL".
  useEffect(() => {
    const currentUrl = searchParams.get('agent');

    if (selectedAgent) {
      if (currentUrl !== selectedAgent.agentId) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set('agent', selectedAgent.agentId);
            return next;
          },
          { replace: true }
        );
      }
    } else {
      // selectedAgent was cleared (e.g. selected agent deleted) — drop the URL param.
      if (currentUrl) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete('agent');
            return next;
          },
          { replace: true }
        );
      }
    }
    // Only the id matters for URL sync; avoid firing on unrelated field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent?.agentId]);

  // Thin wrapper kept for call-site compatibility. The URL is synced by (B),
  // so we only need to update the store here.
  const selectAgentAndUpdateUrl = (agent: Agent | null) => {
    selectAgent(agent);
  };

  return { selectAgentAndUpdateUrl, isAgentResolved };
}
