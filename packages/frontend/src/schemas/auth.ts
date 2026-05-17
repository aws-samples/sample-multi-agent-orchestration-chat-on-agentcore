import { z } from 'zod';
import i18n from '../i18n';

// Login form schema factory
// WHY the custom refine: Cognito User Pool is configured with
// `signInAliases: { username: true, email: true }`, so the login form accepts
// either a username (alphanumeric + `-_`, 3-50 chars) or an email address.
// A plain union/regex would produce confusing error messages; the refine
// accepts whichever matches and falls back to a combined error string.
export const createLoginSchema = () =>
  z.object({
    username: z
      .string()
      .min(1, i18n.t('validation.auth.usernameOrEmailRequired'))
      .refine(
        (value) => {
          const isUsername = /^[a-zA-Z0-9_-]{3,50}$/.test(value);
          const isEmail = z.string().email().safeParse(value).success;
          return isUsername || isEmail;
        },
        { message: i18n.t('validation.auth.usernameOrEmailInvalid') }
      ),
    password: z
      .string()
      .min(8, i18n.t('validation.auth.passwordMinLength'))
      .max(128, i18n.t('validation.auth.passwordMaxLength')),
  });

export type LoginFormData = z.infer<ReturnType<typeof createLoginSchema>>;

// Sign up form schema factory
export const createSignUpSchema = () =>
  z
    .object({
      username: z
        .string()
        .min(3, i18n.t('validation.auth.usernameMinLength'))
        .max(50, i18n.t('validation.auth.usernameMaxLength'))
        .regex(/^[a-zA-Z0-9_-]+$/, i18n.t('validation.auth.usernameInvalidChars')),
      email: z
        .string()
        .min(1, i18n.t('validation.auth.emailRequired'))
        .email(i18n.t('validation.auth.emailInvalid')),
      password: z
        .string()
        .min(8, i18n.t('validation.auth.passwordMinLength'))
        .max(128, i18n.t('validation.auth.passwordMaxLength'))
        .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, i18n.t('validation.auth.passwordComplexity')),
      confirmPassword: z.string().min(1, i18n.t('validation.auth.confirmPasswordRequired')),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: i18n.t('validation.auth.passwordMismatch'),
      path: ['confirmPassword'],
    });

export type SignUpFormData = z.infer<ReturnType<typeof createSignUpSchema>>;

// Confirm sign up form schema factory
export const createConfirmSignUpSchema = () =>
  z.object({
    username: z.string().min(1, i18n.t('validation.auth.usernameRequired')),
    code: z
      .string()
      .min(6, i18n.t('validation.auth.codeLength'))
      .max(6, i18n.t('validation.auth.codeLength'))
      .regex(/^\d{6}$/, i18n.t('validation.auth.codeInvalid')),
  });

export type ConfirmSignUpFormData = z.infer<ReturnType<typeof createConfirmSignUpSchema>>;

// Cognito config schema factory
export const createCognitoConfigSchema = () =>
  z.object({
    userPoolId: z.string().min(1, i18n.t('validation.auth.userPoolIdRequired')),
    clientId: z.string().min(1, i18n.t('validation.auth.clientIdRequired')),
    region: z.string().min(1, i18n.t('validation.auth.regionRequired')),
  });

export type CognitoConfigData = z.infer<ReturnType<typeof createCognitoConfigSchema>>;
