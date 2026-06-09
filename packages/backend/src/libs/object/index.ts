/**
 * Small, dependency-free object helpers.
 *
 * Kept in its own submodule (not the `libs` barrel) so data-access modules can
 * import it without pulling in auth/mcp/http — matching how the repositories
 * already import `libs/http/pagination` directly to keep their dependency
 * surface minimal.
 */

/**
 * Project an object down to a fixed set of keys.
 *
 * Type-safe in both directions: every key must exist on `T` (a typo or a
 * removed field is a compile error), and the result is exactly `Pick<T, K>`.
 * This is the shared form for "stored row → narrower domain/API shape"
 * projections, replacing hand-written field-by-field copies that silently drift
 * from their declared type.
 */
export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    out[key] = obj[key];
  }
  return out;
}
