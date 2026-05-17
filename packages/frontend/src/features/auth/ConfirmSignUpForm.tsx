import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ZodError } from 'zod';
import { Coffee, Mail } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { createConfirmSignUpSchema, type ConfirmSignUpFormData } from '../../schemas/auth';
import { Alert } from '../../components/ui/Alert';

interface ConfirmSignUpFormProps {
  username: string;
  onSwitchToLogin: () => void;
  onBack: () => void;
}

export const ConfirmSignUpForm: React.FC<ConfirmSignUpFormProps> = ({
  username,
  onSwitchToLogin,
  onBack,
}) => {
  const { t } = useTranslation();
  const { confirmSignUp, resendCode, isLoading, error, clearError } = useAuthStore();
  const [formData, setFormData] = useState<ConfirmSignUpFormData>({
    username,
    code: '',
  });
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [resendSuccess, setResendSuccess] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;

    // Confirmation code: digits only, up to 6 digits
    if (name === 'code') {
      const numericValue = value.replace(/\D/g, '').slice(0, 6);
      setFormData((prev) => ({
        ...prev,
        [name]: numericValue,
      }));
    } else {
      setFormData((prev) => ({
        ...prev,
        [name]: value,
      }));
    }

    // Real-time validation
    try {
      const fieldSchema = createConfirmSignUpSchema().shape[name as keyof ConfirmSignUpFormData];
      if (fieldSchema) {
        const testValue = name === 'code' ? value.replace(/\D/g, '').slice(0, 6) : value;
        fieldSchema.parse(testValue);
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

    // Clear errors
    if (error) {
      clearError();
    }
    setResendSuccess(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Validation
      const validatedData = createConfirmSignUpSchema().parse(formData);

      // Execute confirmation
      await confirmSignUp(validatedData.username, validatedData.code);

      // Redirect to login screen on success
      onSwitchToLogin();
    } catch (err) {
      if (err instanceof ZodError && err.issues) {
        // Zod validation error
        const errors: Record<string, string> = {};
        err.issues.forEach((issue) => {
          if (issue.path?.[0]) {
            errors[issue.path[0] as string] = issue.message;
          }
        });
        setValidationErrors(errors);
      }
    }
  };

  const handleResendCode = async () => {
    try {
      setResendSuccess(false);
      await resendCode(username);
      setResendSuccess(true);
    } catch {
      // Error already handled by authStore
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
      <div className="max-w-md w-full space-y-8 p-8">
        <div className="text-center">
          {/* Main icon */}
          <div className="relative mb-4">
            <div className="absolute inset-0 bg-amber-200 rounded-full blur-2xl opacity-30 scale-125"></div>
            <Coffee className="w-12 h-12 text-amber-600 mx-auto mb-2" />
          </div>
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-feedback-success-bg mb-4">
            <Mail className="h-6 w-6 text-feedback-success" aria-hidden="true" />
          </div>
          <h2 className="text-3xl font-bold text-fg-default mb-2">{t('auth.emailVerification')}</h2>
          <p className="text-fg-secondary">
            <strong>{username}</strong> {t('auth.enterCodeSentTo')}
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-fg-secondary mb-2">
                {t('auth.verificationCodeLabel')} <span className="text-feedback-error">*</span>
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={formData.code}
                onChange={handleChange}
                className={`input-field text-center text-lg tracking-widest ${
                  validationErrors.code ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder="000000"
              />
              {validationErrors.code && (
                <p className="mt-2 text-sm text-feedback-error">{validationErrors.code}</p>
              )}
              <p className="mt-1 text-xs text-fg-muted">{t('auth.verificationCodeDescription')}</p>
            </div>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          {resendSuccess && <Alert variant="success">{t('auth.resendCodeSuccess')}</Alert>}

          <div className="flex flex-col space-y-3">
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
                  {t('auth.confirmAction')}
                </>
              ) : (
                t('auth.confirmAccount')
              )}
            </button>

            <button
              type="button"
              onClick={handleResendCode}
              disabled={isLoading}
              className="w-full px-4 py-2 border border-border-strong rounded-2xl text-sm font-medium text-fg-secondary bg-surface-primary hover:bg-surface-secondary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('auth.resendCode')}
            </button>
          </div>
        </form>

        <div className="flex flex-col space-y-2 text-center">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-fg-muted hover:text-fg-secondary transition-colors"
          >
            {t('common.backArrow')} {t('auth.backToSignUp')}
          </button>
          <p className="text-sm text-fg-secondary">
            {t('auth.hasAccount')}{' '}
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="font-medium text-indigo-600 hover:text-indigo-500 transition-colors"
            >
              {t('auth.signIn')}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};
