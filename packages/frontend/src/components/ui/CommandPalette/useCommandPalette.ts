/**
 * Command Palette state management hook
 */

import { useState, useEffect, useCallback } from 'react';

/**
 * Custom hook for managing Command Palette open/close state
 * Handles Cmd+K / Ctrl+K keyboard shortcut
 */
export const useCommandPalette = () => {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  // Global keyboard shortcut listener
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Mac: Cmd+K only, Windows/Linux: Ctrl+K only
      const isCorrectModifier = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (isCorrectModifier && event.key === 'k') {
        event.preventDefault();
        toggle();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggle]);

  return {
    isOpen,
    open,
    close,
    toggle,
    setIsOpen,
  };
};
