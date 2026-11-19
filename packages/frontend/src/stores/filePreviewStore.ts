import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface FilePreviewState {
  /** Whether the chat's preview dock is shown. Persisted as a user preference. */
  isOpen: boolean;
  /** Storage path shown in the dock; null shows the empty state. */
  path: string | null;
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
