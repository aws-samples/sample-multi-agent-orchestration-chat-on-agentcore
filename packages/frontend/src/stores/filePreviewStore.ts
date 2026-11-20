import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface FilePreviewState {
  /** Whether the chat's preview dock is shown. Persisted as a user preference. */
  isOpen: boolean;
  /** Storage path shown in the dock; null shows the empty state. */
  path: string | null;
  /** In-app file links currently rendered (S3FileLink with onOpen). */
  linkCount: number;
  /** Counts a rendered file link; returns the matching unregister. */
  registerLink: () => () => void;
  /** Shows `path` in the dock, opening it if hidden. */
  open: (path: string) => void;
  toggle: () => void;
  close: () => void;
  /** Forgets the file (e.g. on session switch) without changing visibility. */
  clearFile: () => void;
}

export const useFilePreviewStore = create<FilePreviewState>()(
  devtools(
    persist(
      (set) => ({
        isOpen: false,
        path: null,
        linkCount: 0,
        registerLink: () => {
          set((s) => ({ linkCount: s.linkCount + 1 }));
          return () => set((s) => ({ linkCount: s.linkCount - 1 }));
        },
        open: (path) => set({ isOpen: true, path }),
        toggle: () => set((s) => ({ isOpen: !s.isOpen })),
        close: () => set({ isOpen: false }),
        clearFile: () => set({ path: null }),
      }),
      {
        name: 'file-preview-storage',
        partialize: (s) => ({ isOpen: s.isOpen }),
      }
    ),
    { name: 'file-preview-store' }
  )
);

/**
 * Whether the dock has anything to show: a file is loaded, or the conversation
 * links to one. Without this the toggle and an empty dock (the open state is
 * a persisted preference) appear in chats that never mention a file.
 */
export function useFilePreviewAvailable(): boolean {
  return useFilePreviewStore((s) => s.path !== null || s.linkCount > 0);
}
