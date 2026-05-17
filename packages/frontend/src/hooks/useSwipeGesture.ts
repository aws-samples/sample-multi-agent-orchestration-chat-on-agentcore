/**
 * Custom hook for detecting swipe gestures
 * Used for opening/closing the sidebar on mobile
 */

import { useEffect, useCallback, useRef } from 'react';

interface SwipeGestureOptions {
  /**
   * Callback for rightward swipe
   */
  onSwipeRight?: () => void;

  /**
   * Callback for leftward swipe
   */
  onSwipeLeft?: () => void;

  /**
   * Minimum distance to register as a swipe (px)
   * @default 50
   */
  threshold?: number;

  /**
   * Active range from the screen edge (px)
   * Right swipe is only detected when touch starts within this range from the left edge
   * @default 30
   */
  edgeThreshold?: number;

  /**
   * Velocity threshold for detection (px/ms)
   * Treated as a flick if speed exceeds this value
   * @default 0.3
   */
  velocityThreshold?: number;

  /**
   * Enable/disable gesture
   * @default true
   */
  enabled?: boolean;

  /**
   * Whether to only enable swipe from screen edge
   * @default true
   */
  requireEdgeStart?: boolean;
}

interface TouchState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startTime: number;
  isTracking: boolean;
  direction: 'horizontal' | 'vertical' | null;
}

export function useSwipeGesture(options: SwipeGestureOptions) {
  const {
    onSwipeRight,
    onSwipeLeft,
    threshold = 50,
    edgeThreshold = 30,
    velocityThreshold = 0.3,
    enabled = true,
    requireEdgeStart = true,
  } = options;

  const touchState = useRef<TouchState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    startTime: 0,
    isTracking: false,
    direction: null,
  });

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (!enabled) return;

      const touch = e.touches[0];
      if (!touch) return;

      const startX = touch.clientX;
      const startY = touch.clientY;

      // If requiring swipe from screen edge, check left edge
      if (requireEdgeStart && onSwipeRight && startX > edgeThreshold) {
        return;
      }

      touchState.current = {
        startX,
        startY,
        currentX: startX,
        currentY: startY,
        startTime: Date.now(),
        isTracking: true,
        direction: null,
      };
    },
    [enabled, edgeThreshold, onSwipeRight, requireEdgeStart]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!enabled || !touchState.current.isTracking) return;

      const touch = e.touches[0];
      if (!touch) return;

      const currentX = touch.clientX;
      const currentY = touch.clientY;

      touchState.current.currentX = currentX;
      touchState.current.currentY = currentY;

      // Direction has not been determined yet
      if (!touchState.current.direction) {
        const deltaX = Math.abs(currentX - touchState.current.startX);
        const deltaY = Math.abs(currentY - touchState.current.startY);

        // Determine direction on first movement (determine after 5px or more)
        if (deltaX > 5 || deltaY > 5) {
          if (deltaX > deltaY) {
            // Horizontal
            touchState.current.direction = 'horizontal';
          } else {
            // Vertical (scroll)
            touchState.current.direction = 'vertical';
            touchState.current.isTracking = false;
            return;
          }
        }
      }

      // For horizontal swipe, prevent default scrolling
      if (touchState.current.direction === 'horizontal') {
        e.preventDefault();
      }
    },
    [enabled]
  );

  const handleTouchEnd = useCallback(() => {
    if (!enabled || !touchState.current.isTracking) return;

    const { startX, startY, currentX, currentY, startTime, direction } = touchState.current;

    // Do nothing for vertical direction
    if (direction !== 'horizontal') {
      touchState.current.isTracking = false;
      return;
    }

    const deltaX = currentX - startX;
    const deltaY = Math.abs(currentY - startY);
    const deltaTime = Date.now() - startTime;
    const velocity = Math.abs(deltaX) / deltaTime;

    // Ignore if vertical movement is too large
    if (deltaY > 50) {
      touchState.current.isTracking = false;
      return;
    }

    // Right swipe detection
    if (deltaX > threshold || (deltaX > 0 && velocity > velocityThreshold)) {
      onSwipeRight?.();
    }
    // Left swipe detection
    else if (deltaX < -threshold || (deltaX < 0 && velocity > velocityThreshold)) {
      onSwipeLeft?.();
    }

    touchState.current.isTracking = false;
  }, [enabled, threshold, velocityThreshold, onSwipeRight, onSwipeLeft]);

  useEffect(() => {
    if (!enabled) return;

    // Specify passive: false to enable preventDefault
    const options: AddEventListenerOptions = { passive: false };

    document.addEventListener('touchstart', handleTouchStart, options);
    document.addEventListener('touchmove', handleTouchMove, options);
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [enabled, handleTouchStart, handleTouchMove, handleTouchEnd]);
}
