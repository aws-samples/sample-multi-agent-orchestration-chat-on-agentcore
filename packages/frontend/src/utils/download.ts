/**
 * Download a file that requires an async presigned URL fetch.
 * Opens a blank window synchronously to preserve user gesture context,
 * then redirects after the URL is fetched.
 *
 * IMPORTANT: Must be called synchronously within a user gesture handler
 * to preserve transient activation on mobile browsers.
 *
 * @param fetchUrl - Async function that returns the download URL
 * @param onError - Optional error callback
 * @returns The fetched URL on success, or null on failure
 */
export async function downloadWithAsyncUrl(
  fetchUrl: () => Promise<string>,
  onError?: (error: Error) => void
): Promise<string | null> {
  // Open window synchronously — preserves transient activation
  const newWindow = window.open('', '_blank');

  try {
    const url = await fetchUrl();

    if (newWindow && !newWindow.closed) {
      newWindow.location.href = url;
    } else {
      // window.open was blocked (e.g., PWA standalone mode or popup blocker).
      // Do NOT fallback to window.location.href as it navigates away from the app.
      const error = new Error('Popup was blocked. Please allow popups and try again.');
      onError?.(error);
      return null;
    }

    return url;
  } catch (err) {
    if (newWindow && !newWindow.closed) newWindow.close();
    const error = err instanceof Error ? err : new Error('Download failed');
    onError?.(error);
    return null;
  }
}
