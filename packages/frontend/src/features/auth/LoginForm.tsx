import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ZodError } from 'zod';
import { Coffee } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { createLoginSchema, type LoginFormData } from '../../schemas/auth';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';

interface LoginFormProps {
  onSwitchToSignUp?: () => void;
  onSwitchToForgotPassword?: () => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({
  onSwitchToSignUp,
  onSwitchToForgotPassword,
}) => {
  const { t } = useTranslation();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [formData, setFormData] = useState<LoginFormData>({
    username: '',
    password: '',
  });
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    // Real-time validation
    try {
      createLoginSchema().shape[name as keyof LoginFormData].parse(value);
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
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Validation
      const validatedData = createLoginSchema().parse(formData);

      // Execute login
      await login(validatedData.username, validatedData.password);
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary">
      <div className="max-w-md w-full space-y-8 p-8">
        <div className="text-center">
          {/* Main icon */}
          <div className="relative mb-6">
            <div className="absolute inset-0 bg-amber-200 rounded-full blur-2xl opacity-30 scale-125"></div>
            <Coffee className="w-16 h-16 text-amber-600 mx-auto" />
          </div>
          <p className="text-fg-secondary text-sm">{t('auth.welcomeDescription')}</p>
          <p className="text-fg-secondary text-sm">{t('auth.welcomeDescriptionLine2')}</p>
        </div>

        {/*
          WHY method="post" / action: Safari and some Chromium password
          managers detect "successful login" via a form POST followed by a
          navigation. SPAs call preventDefault() so no real POST fires, but
          setting these attributes makes the heuristic recognize the form
          as a login form and offer to save the credentials.
        */}
        <form className="mt-8 space-y-6" method="post" action="#" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-fg-secondary mb-2"
              >
                {t('auth.usernameOrEmail')}
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                value={formData.username}
                onChange={handleChange}
                className={`input-field ${
                  validationErrors.username ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder={t('auth.placeholderUsernameOrEmail')}
              />
              {validationErrors.username && (
                <p className="mt-2 text-sm text-feedback-error">{validationErrors.username}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-fg-secondary mb-2"
              >
                {t('auth.password')}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={formData.password}
                onChange={handleChange}
                className={`input-field ${
                  validationErrors.password ? 'border-red-300 focus:ring-red-300' : ''
                }`}
                placeholder={t('auth.placeholderPassword')}
              />
              {validationErrors.password && (
                <p className="mt-2 text-sm text-feedback-error">{validationErrors.password}</p>
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
            {isLoading ? t('auth.signInAction') : t('auth.signIn')}
          </Button>
        </form>

        <div className="text-center space-y-2">
          {onSwitchToSignUp && (
            <p className="text-sm text-fg-secondary">
              {t('auth.noAccount')}{' '}
              <button
                type="button"
                onClick={onSwitchToSignUp}
                className="font-medium text-indigo-600 hover:text-indigo-500 transition-colors"
              >
                {t('auth.signUp')}
              </button>
            </p>
          )}
          {onSwitchToForgotPassword && (
            <p className="text-sm">
              <button
                type="button"
                onClick={onSwitchToForgotPassword}
                className="text-fg-secondary hover:text-indigo-600 transition-colors"
              >
                {t('auth.forgotPassword.link')}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
