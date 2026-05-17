import React, { useState } from 'react';
import { ZodError, z } from 'zod';
import { Coffee, CheckCircle } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';

interface ForceChangePasswordFormProps {
  onSuccess?: () => void;
}

export const ForceChangePasswordForm: React.FC<ForceChangePasswordFormProps> = ({ onSuccess }) => {
  const { t } = useTranslation();
  const { completeNewPassword, isLoading, error, clearError } = useAuthStore();

  const forceChangePasswordSchema = z
    .object({
      newPassword: z
        .string()
        .min(8, t('auth.forceChangePassword.passwordMinLength'))
        .regex(/[A-Z]/, t('auth.forceChangePassword.passwordUpperCase'))
        .regex(/[a-z]/, t('auth.forceChangePassword.passwordLowerCase'))
        .regex(/[0-9]/, t('auth.forceChangePassword.passwordNumber')),
      confirmPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: t('auth.forceChangePassword.passwordMismatch'),
      path: ['confirmPassword'],
    });

  type ForceChangePasswordFormData = z.infer<typeof forceChangePasswordSchema>;

  const [formData, setFormData] = useState<ForceChangePasswordFormData>({
    newPassword: '',
    confirmPassword: '',
  });
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
        forceChangePasswordSchema.parse({ ...formData, [name]: value });
      } else {
        forceChangePasswordSchema.shape[name as keyof typeof forceChangePasswordSchema.shape].parse(
          value
        );
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
      clearError();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Validation
      const validatedData = forceChangePasswordSchema.parse(formData);

      // Execute password change
      await completeNewPassword(validatedData.newPassword);

      // Show success
      setIsSuccess(true);

      // Redirect after 2 seconds
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
      }
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
            {t('auth.forceChangePassword.successTitle')}
          </h2>
          <p className="text-fg-secondary">{t('auth.forceChangePassword.successDescription')}</p>
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
          <h2 className="text-2xl font-bold text-amber-900 mb-2 whitespace-nowrap">
            {t('auth.forceChangePassword.title')}
          </h2>
          <p className="text-fg-secondary text-sm">{t('auth.forceChangePassword.description')}</p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="newPassword"
                className="block text-sm font-medium text-fg-secondary mb-2"
              >
                {t('auth.forceChangePassword.newPassword')}
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
                placeholder={t('auth.forceChangePassword.newPasswordPlaceholder')}
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
                {t('auth.forceChangePassword.confirmNewPassword')}
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
                placeholder={t('auth.forceChangePassword.confirmNewPasswordPlaceholder')}
              />
              {validationErrors.confirmPassword && (
                <p className="mt-2 text-sm text-feedback-error">
                  {validationErrors.confirmPassword}
                </p>
              )}
            </div>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <Button
            type="submit"
            disabled={isLoading}
            loading={isLoading}
            fullWidth
            size="lg"
            className="bg-gray-900 hover:bg-gray-800"
          >
            {isLoading
              ? t('auth.forceChangePassword.changingButton')
              : t('auth.forceChangePassword.changeButton')}
          </Button>
        </form>
      </div>
    </div>
  );
};
