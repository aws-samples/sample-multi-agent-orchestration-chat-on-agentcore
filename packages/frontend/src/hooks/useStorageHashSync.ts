/**
 * Keeps the storage modal's current path in sync with the URL hash
 * (`#storage=<path>`), so deep links, browser Back/Forward, and closing the
 * modal all behave. Encapsulates three window/history side effects that were
 * inline in StorageManagementModal.
 *
 * The pure hash helpers are module-level (they capture nothing); the hook wires
 * the open-time load and the popstate/hashchange listeners.
 */

import { useEffect } from 'react';
import { useStorageStore } from '../stores/storageStore';

/** Read the `#storage=<path>` hash, or '/' when absent. */
export function getPathFromHash(): string {
  const match = window.location.hash.match(/#storage=(.+)/);
  return match ? decodeURIComponent(match[1]) : '/';
}

/** Push a `#storage=<path>` hash entry (adds history so Back works). */
export function setPathToHash(path: string): void {
  window.history.pushState(null, '', `#storage=${encodeURIComponent(path)}`);
}

/** Drop the storage hash (leaving any unrelated hash untouched). */
export function clearHash(): void {
  if (window.location.hash.startsWith('#storage=')) {
    window.history.pushState(null, '', window.location.pathname + window.location.search);
  }
}

export interface UseStorageHashSyncParams {
  isOpen: boolean;
  onClose: () => void;
  /** Default initial path when the URL has no explicit storage hash. */
  agentWorkingDirectory: string;
  loadItems: (path?: string) => Promise<void>;
  loadFolderTree: () => Promise<void>;
}

export interface UseStorageHashSyncResult {
  /** Push a hash entry; used by the modal's navigation handlers. */
  setPathToHash: (path: string) => void;
}

export function useStorageHashSync({
  isOpen,
  onClose,
  agentWorkingDirectory,
  loadItems,
  loadFolderTree,
}: UseStorageHashSyncParams): UseStorageHashSyncResult {
  // Load data when the modal opens; clear the hash when it closes.
  useEffect(() => {
    if (isOpen) {
      // Use the URL hash if explicitly set, otherwise the agent working dir.
      const hasExplicitHash = window.location.hash.startsWith('#storage=');
      const initialPath = hasExplicitHash ? getPathFromHash() : agentWorkingDirectory || '/';

      setPathToHash(initialPath);
      loadItems(initialPath);
      loadFolderTree();
    } else {
      clearHash();
    }
    // Must run once per open only; re-running when agentWorkingDirectory /
    // loadItems / loadFolderTree identities change would reset the path or
    // re-fetch mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Sync on browser back/forward and manual hash edits.
  useEffect(() => {
    if (!isOpen) return;

    const handleHashChange = () => {
      if (window.location.hash.startsWith('#storage=')) {
        // Read fresh store state directly to keep this effect's deps minimal.
        useStorageStore.getState().loadItems(getPathFromHash());
      } else {
        // Hash cleared (e.g. Back past the modal entry) → close the modal.
        onClose();
      }
    };

    window.addEventListener('popstate', handleHashChange);
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('popstate', handleHashChange);
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [isOpen, onClose]);

  return { setPathToHash };
}
