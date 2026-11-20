import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface FilePreviewState {
  /** Whether the chat's preview dock is shown. Persisted as a user preference. */
  isOpen: boolean;
  /** Storage path shown in the dock; null shows the empty state. */
  path: string | null;
  /**
   * The user opened the dock with no file in it. Only then is the empty state
   * shown: a persisted "open" alone would pop an empty dock over the chat the
   * moment the first file link streams in.
   */
  emptyRequested: boolean;
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
        emptyRequested: false,
        open: (path) => set({ isOpen: true, path }),
        toggle: () => set((s) => ({ isOpen: !s.isOpen, emptyRequested: !s.isOpen })),
        close: () => set({ isOpen: false, emptyRequested: false }),
        clearFile: () => set({ path: null, emptyRequested: false }),
      }),
      {
        name: 'file-preview-storage',
        partialize: (s) => ({ isOpen: s.isOpen }),
      }
    ),
    { name: 'file-preview-store' }
  )
);
