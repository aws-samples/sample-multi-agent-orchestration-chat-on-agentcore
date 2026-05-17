/**
 * Tooltip Component
 * General-purpose tooltip component
 */

import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

export interface TooltipProps {
  /** Trigger element that shows the tooltip */
  children: ReactNode;
  /** Content to display in the tooltip */
  content: ReactNode;
  /** Tooltip display position */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Fixed width (when set, displays at this fixed width) */
  width?: string;
  /** Maximum width (default: 240px) */
  maxWidth?: string;
  /** Disable the tooltip */
  disabled?: boolean;
  /** Display delay time (milliseconds, default: 200) */
  delay?: number;
}

/**
 * General-purpose component that shows a tooltip on hover
 */
export function Tooltip({
  children,
  content,
  position = 'top',
  width,
  maxWidth = '240px',
  disabled = false,
  delay = 0,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  // Clean up timer on component unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // If disabled, return only the children
  if (disabled) {
    return <>{children}</>;
  }

  // Show tooltip with delay on mouse enter
  const handleMouseEnter = () => {
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  // Clear timer and hide tooltip on mouse leave
  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  // Style classes based on position
  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  // Style classes for arrow position
  const arrowClasses = {
    top: 'top-full left-1/2 -translate-x-1/2 border-t-gray-900',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 border-b-gray-900',
    left: 'left-full top-1/2 -translate-y-1/2 border-l-gray-900',
    right: 'right-full top-1/2 -translate-y-1/2 border-r-gray-900',
  };

  return (
    <div
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {/* Tooltip body */}
      {isVisible && (
        <div
          className={`
            absolute z-50
            ${positionClasses[position]}
            pointer-events-none
            animate-in fade-in-0 zoom-in-95 duration-150
          `}
          style={{ width: width, maxWidth: maxWidth }}
        >
          {/* Tooltip background */}
          <div
            className={`relative bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg ${
              width ? 'whitespace-normal break-words' : 'whitespace-nowrap'
            }`}
          >
            {content}

            {/* Arrow */}
            <div
              className={`
                absolute w-0 h-0
                border-4 border-transparent
                ${arrowClasses[position]}
              `}
            />
          </div>
        </div>
      )}
    </div>
  );
}
