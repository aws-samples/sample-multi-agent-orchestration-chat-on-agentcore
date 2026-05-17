import React, { createContext, useContext, useEffect } from 'react';
import { cn } from '../../../lib/utils';
import { useUIStore } from '../../../stores/uiStore';
import type { ModalProps, ModalContextType } from './types';

const ModalContext = createContext<ModalContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export const useModalContext = () => {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error('Modal components must be used within a Modal');
  }
  return context;
};

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  size = 'lg',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  className,
  children,
}) => {
  const { isMobileView } = useUIStore();

  // Close on ESC key
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => {
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [isOpen, onClose, closeOnEscape]);

  // Body scroll control
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Full screen on mobile for xl size
  const isMobileFullscreen = isMobileView && size === 'xl';

  // Class mapping for each size
  const sizeClasses: Record<NonNullable<ModalProps['size']>, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: isMobileView ? 'w-full h-full' : 'max-w-7xl min-h-[70vh] w-[90vw]',
    full: 'max-w-none w-full h-full',
  };

  const sizeClass = sizeClasses[size];
  const heightClass = size === 'full' || isMobileFullscreen ? 'h-full' : 'max-h-[calc(100vh-2rem)]';
  const borderRadius = isMobileFullscreen ? 'rounded-none' : 'rounded-3xl';
  const padding = isMobileFullscreen ? 'p-0' : 'p-4';

  return (
    <ModalContext.Provider value={{ onClose }}>
      <div
        className={cn('fixed inset-0 z-50 bg-black/10 flex items-center justify-center', padding)}
      >
        <div className="fixed inset-0" onClick={closeOnOverlayClick ? onClose : undefined} />
        <div
          className={cn(
            'bg-surface-primary shadow-2xl flex flex-col overflow-hidden relative',
            borderRadius,
            sizeClass,
            heightClass,
            className
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </ModalContext.Provider>
  );
};
