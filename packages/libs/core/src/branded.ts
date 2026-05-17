/**
 * Branded Type Infrastructure
 *
 * TypeScript uses structural typing, which cannot distinguish between two string types.
 * By attaching a "brand" via a unique symbol, we achieve nominal typing.
 *
 * Usage:
 *   type SessionId = Brand<string, 'SessionId'>;
 *   type AgentId   = Brand<string, 'AgentId'>;
 *
 * This makes SessionId and AgentId mutually non-assignable.
 * Converting from a plain string requires an explicit parse / generate function.
 */

declare const __brand: unique symbol;

/**
 * Generic utility type that attaches a brand B to any base type T.
 *
 * @typeParam T - Base type (typically string)
 * @typeParam B - Brand identifier (string literal)
 */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };
