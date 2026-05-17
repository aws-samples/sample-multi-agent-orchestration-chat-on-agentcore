import React, { useState } from 'react';
import { ZodError, z } from 'zod';
import { Coffee, ArrowLeft } from 'lucide-react';
import { authService } from '../../lib/auth';
import { useTranslation } from 'react-i18next';

interface ForgotPasswordFormProps {
  onSwitchToLogin?: () => void;
  onCodeSent?: (email: string) => void;
}

export const ForgotPasswordForm: React.FC<ForgotPasswordFormProps> = ({
  onSwitchToLogin,
  onCodeSent,
}) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string>('');

  const emailSchema = z.object({
    email: z.string().email(t('auth.forgotPassword.validEmail')),
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);

    // Real-time validation
    try {
      emailSchema.shape.email.parse(value);
      setValidationError('');
    } catch (err) {
      if (err instanceof ZodError && err.issues?.[0]?.message) {
        setValidationError(err.issues[0].message);
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
      emailSchema.parse({ email });

      setIsLoading(true);
      setError(null);

      // Send password reset code
      await authService.resetPassword(email);

      // Go to next screen on success
      if (onCodeSent) {
        onCodeSent(email);
      }
    } catch (err) {
      if (err instanceof ZodError && err.issues) {
        setValidationError(err.issues[0]?.message || 'バリデーションエラー');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('auth.forgotPassword.sendFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
      <div className="max-w-md w-full space-y-8 p-8">
        <div className="text-center">
          {/* Main icon */}
          <div className="relative mb-6">
            <div className="absolute inset-0 bg-amber-200 rounded-full blur-2xl opacity-30 scale-125"></div>
            <Coffee className="w-16 h-16 text-amber-600 mx-auto" />
          </div>
          <h2 className="text-3xl font-bold text-amber-900 mb-2">
            {t('auth.forgotPassword.title')}
          </h2>
          <p className="text-fg-secondary text-sm">{t('auth.forgotPassword.description')}</p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-fg-secondary mb-2">
                {t('auth.email')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={handleChange}
                className={`input-field ${
                  validationError ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder="example@email.com"
              />
              {validationError && (
                <p className="mt-2 text-sm text-feedback-error">{validationError}</p>
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
                {t('auth.forgotPassword.sendingCode')}
              </>
            ) : (
              t('auth.forgotPassword.sendCode')
            )}
          </button>
        </form>

        <div className="text-center space-y-2">
          {onSwitchToLogin && (
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="flex items-center justify-center w-full text-sm text-fg-secondary hover:text-fg-default transition-colors"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('auth.forgotPassword.backToLogin')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
