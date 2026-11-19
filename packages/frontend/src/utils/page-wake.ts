/**
 * Call `onWake` whenever the page may have been asleep: it became visible,
 * was restored from the back/forward cache, or came back online. iOS PWAs
 * freeze JS (timers, sockets) in the background, so this is the only reliable
 * signal that the app needs to catch up.
 *
 * @returns A function that removes the listeners.
 */
export function onPageWake(onWake: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') onWake();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('online', onWake);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onWake);
    window.removeEventListener('online', onWake);
  };
}
