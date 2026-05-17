/**
 * Back-compat re-export.
 * The implementation has moved to `libs/auth/auth-resolver.ts`.
 */
export {
  REQUIRED_MACHINE_USER_SCOPE,
  validateMachineUserScopes,
  validateTargetUserId,
  resolveEffectiveUserId,
} from '../libs/auth/auth-resolver.js';
