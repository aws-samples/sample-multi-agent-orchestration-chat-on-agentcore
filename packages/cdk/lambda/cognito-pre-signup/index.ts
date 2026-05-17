/**
 * Cognito Pre Sign-up Lambda Trigger
 *
 * Restricts self sign-up to the email domains listed in the `ALLOWED_DOMAINS`
 * environment variable (comma-separated). Throwing an error here causes
 * Cognito to reject the SignUp API call with the thrown message, so the
 * string is shown to end users via the hosted UI / SDK.
 *
 * Auto-confirm / auto-verify are intentionally left disabled — Cognito
 * still requires the normal email verification flow.
 */

import type { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from 'aws-lambda';

function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

export const handler: PreSignUpTriggerHandler = async (event: PreSignUpTriggerEvent) => {
  const allowedDomains = parseAllowedDomains(process.env.ALLOWED_DOMAINS);

  const email = event.request.userAttributes.email;
  if (!email) {
    throw new Error('Email is required for sign up');
  }

  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) {
    throw new Error('Invalid email format');
  }

  if (!allowedDomains.includes(emailDomain)) {
    throw new Error(
      `Sign up is restricted to the following email domains: ${allowedDomains.join(', ')}`
    );
  }

  // Cognito still enforces the standard verification flow.
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;

  return event;
};
