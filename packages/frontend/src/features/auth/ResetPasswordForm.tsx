import React, { useState } from 'react';
import { ZodError, z } from 'zod';
import { Coffee, ArrowLeft, CheckCircle } from 'lucide-react';
import { authService } from '../../lib/auth';
import { useTranslation } from 'react-i18next';

interface ResetPasswordFormProps {
  email: string;
  onSuccess?: () => void;
  onBack?: () => void;
}

export const ResetPasswordForm: React.FC<ResetPasswordFormProps> = ({
  email,
  onSuccess,
  onBack,
}) => {
  const { t } = useTranslation();

  const resetPasswordSchema = z
    .object({
      code: z.string().min(6, t('auth.resetPassword.codeMinLength')),
      newPassword: z
        .string()
        .min(8, t('auth.resetPassword.passwordMinLength'))
        .regex(/[A-Z]/, t('auth.resetPassword.passwordUpperCase'))
        .regex(/[a-z]/, t('auth.resetPassword.passwordLowerCase'))
        .regex(/[0-9]/, t('auth.resetPassword.passwordNumber')),
      confirmPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: t('auth.resetPassword.passwordMismatch'),
      path: ['confirmPassword'],
    });

  type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;
  const [formData, setFormData] = useState<ResetPasswordFormData>({
    code: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [isSuccess, setIsSuccess] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    // Real-time validation
    try {
      if (name === 'confirmPassword') {
        resetPasswordSchema.parse({ ...formData, [name]: value });
      } else {
        resetPasswordSchema.shape[name as keyof typeof resetPasswordSchema.shape].parse(value);
      }
      setValidationErrors((prev) => ({
        ...prev,
        [name]: '',
      }));
    } catch (err) {
      if (err instanceof ZodError && err.issues?.[0]?.message) {
        setValidationErrors((prev) => ({
          ...prev,
          [name]: err.issues[0].message,
        }));
      }
    }

    if (error) {
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Validation
      const validatedData = resetPasswordSchema.parse(formData);

      setIsLoading(true);
      setError(null);

      // Execute password reset
      await authService.confirmResetPassword(email, validatedData.code, validatedData.newPassword);

      // Show success
      setIsSuccess(true);

      // Redirect to login screen after 2 seconds
      setTimeout(() => {
        if (onSuccess) {
          onSuccess();
        }
      }, 2000);
    } catch (err) {
      if (err instanceof ZodError && err.issues) {
        const errors: Record<string, string> = {};
        err.issues.forEach((issue) => {
          if (issue.path?.[0]) {
            errors[issue.path[0] as string] = issue.message;
          }
        });
        setValidationErrors(errors);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('auth.resetPassword.resetFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
        <div className="max-w-md w-full space-y-8 p-8 text-center">
          <div className="relative mb-6">
            <div className="absolute inset-0 bg-green-200 rounded-full blur-2xl opacity-30 scale-125"></div>
            <CheckCircle className="w-16 h-16 text-green-600 mx-auto" />
          </div>
          <h2 className="text-3xl font-bold text-fg-default mb-2">
            {t('auth.resetPassword.successTitle')}
          </h2>
          <p className="text-fg-secondary">{t('auth.resetPassword.successDescription')}</p>
          <div className="flex justify-center">
            <svg className="animate-spin h-8 w-8 text-amber-600" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="m12 2v4m0 12v4m10-10h-4m-12 0H2m15.364-7.364-2.829 2.829m-9.899 9.899-2.829 2.829m12.728 0-2.829-2.829M4.929 4.929l-2.829 2.829"
              ></path>
            </svg>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
      <div className="max-w-md w-full space-y-8 p-8">
        <div className="text-center">
          <div className="relative mb-6">
            <div className="absolute inset-0 bg-amber-200 rounded-full blur-2xl opacity-30 scale-125"></div>
            <Coffee className="w-16 h-16 text-amber-600 mx-auto" />
          </div>
          <h2 className="text-3xl font-bold text-amber-900 mb-2">
            {t('auth.resetPassword.title')}
          </h2>
          <p className="text-fg-secondary text-sm">{t('auth.resetPassword.description')}</p>
          <p className="text-fg-secondary text-sm mt-2">
            {t('auth.email')}: <span className="font-semibold">{email}</span>
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-fg-secondary mb-2">
                {t('auth.resetPassword.code')}
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={formData.code}
                onChange={handleChange}
                className={`input-field ${
                  validationErrors.code ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder="6桁の確認コードを入力"
              />
              {validationErrors.code && (
                <p className="mt-2 text-sm text-feedback-error">{validationErrors.code}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="newPassword"
                className="block text-sm font-medium text-fg-secondary mb-2"
              >
                {t('auth.resetPassword.newPassword')}
              </label>
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                value={formData.newPassword}
                onChange={handleChange}
                className={`input-field ${
                  validationErrors.newPassword ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder="新しいパスワードを入力"
              />
              {validationErrors.newPassword && (
                <p className="mt-2 text-sm text-feedback-error">{validationErrors.newPassword}</p>
              )}
              <p className="mt-2 text-xs text-fg-muted">{t('auth.passwordRequirements')}</p>
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-fg-secondary mb-2"
              >
                {t('auth.resetPassword.confirmNewPassword')}
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={formData.confirmPassword}
                onChange={handleChange}
                className={`input-field ${
                  validationErrors.confirmPassword ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder="パスワードを再入力"
              />
              {validationErrors.confirmPassword && (
                <p className="mt-2 text-sm text-feedback-error">
                  {validationErrors.confirmPassword}
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="bg-feedback-error-bg border border-feedback-error-border rounded-2xl p-4">
              <div className="flex">
                <div className="flex-shrink-0">
                  <svg
                    className="h-5 w-5 text-feedback-error"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div className="ml-3">
                  <p className="text-sm text-feedback-error">{error}</p>
                </div>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="button-primary w-full flex justify-center items-center"
          >
            {isLoading ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="m12 2v4m0 12v4m10-10h-4m-12 0H2m15.364-7.364-2.829 2.829m-9.899 9.899-2.829 2.829m12.728 0-2.829-2.829M4.929 4.929l-2.829 2.829"
                  ></path>
                </svg>
                {t('auth.resetPassword.resettingButton')}
              </>
            ) : (
              t('auth.resetPassword.resetButton')
            )}
          </button>
        </form>

        <div className="text-center space-y-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex items-center justify-center w-full text-sm text-fg-secondary hover:text-fg-default transition-colors"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('auth.resetPassword.backToForgotPassword')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
