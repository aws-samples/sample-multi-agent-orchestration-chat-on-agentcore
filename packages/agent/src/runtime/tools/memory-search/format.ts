/**
 * Pure result-formatting helpers for the memory_search tool.
 *
 * These functions compose the exact user-facing strings returned to the model.
 * They are free of I/O so they can be unit-tested without AWS dependencies; the
 * impure retrieval lives in `memory-search.tool.ts`.
 */

/**
 * Compose the guidance string returned when a search yields no records.
 */
export function formatNoMemories(query: string): string {
  return `No memories found for query: "${query}". The user may not have relevant past interactions on this topic.`;
}

/**
 * Compose the success string for one or more retrieved memory records.
 *
 * Memories are rendered as a 1-based numbered list, one per line, beneath a
 * count header that echoes the original query.
 */
export function formatMemories(query: string, memories: string[]): string {
  const formattedMemories = memories.map((memory, index) => `${index + 1}. ${memory}`).join('\n');

  return (
    `Found ${memories.length} relevant memory record(s) for query "${query}":\n\n` + formattedMemories
  );
}
