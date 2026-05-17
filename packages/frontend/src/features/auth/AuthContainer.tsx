import React, { useEffect, useState } from 'react';
import { Routes, Route, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { LoginForm } from './LoginForm';
import { SignUpForm } from './SignUpForm';
import { ConfirmSignUpForm } from './ConfirmSignUpForm';
import { ForgotPasswordForm } from './ForgotPasswordForm';
import { ResetPasswordForm } from './ResetPasswordForm';
import { ForceChangePasswordForm } from './ForceChangePasswordForm';

const isSelfSignUpEnabled = import.meta.env.VITE_SELF_SIGN_UP_ENABLED === 'true';

export const AuthContainer: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    needsConfirmation,
    pendingUsername,
    setNeedsConfirmation,
    needsNewPassword,
    setNeedsNewPassword,
  } = useAuthStore();
  const [resetPasswordEmail, setResetPasswordEmail] = useState<string>('');

  // Redirect to /confirm if confirmation needed
  useEffect(() => {
    if (needsConfirmation && pendingUsername && location.pathname !== '/confirm') {
      navigate('/confirm', { replace: true });
    }
  }, [needsConfirmation, pendingUsername, location.pathname, navigate]);

  // Redirect to /force-change-password if new password required
  useEffect(() => {
    if (needsNewPassword && location.pathname !== '/force-change-password') {
      navigate('/force-change-password', { replace: true });
    }
  }, [needsNewPassword, location.pathname, navigate]);

  const handleSwitchToLogin = () => {
    setNeedsConfirmation(false);
    setNeedsNewPassword(false);
    navigate('/login');
  };

  const handleSwitchToSignUp = isSelfSignUpEnabled
    ? () => {
        setNeedsConfirmation(false);
        navigate('/signup');
      }
    : undefined;

  const handleBackToSignUp = isSelfSignUpEnabled
    ? () => {
        setNeedsConfirmation(false);
        navigate('/signup');
      }
    : undefined;

  const handleSwitchToForgotPassword = () => {
    navigate('/forgot-password');
  };

  const handleForgotPasswordCodeSent = (email: string) => {
    setResetPasswordEmail(email);
    navigate('/reset-password');
  };

  const handleResetPasswordSuccess = () => {
    navigate('/login');
  };

  const handleResetPasswordBack = () => {
    navigate('/forgot-password');
  };

  const handleForceChangePasswordSuccess = () => {
    setNeedsNewPassword(false);
    // Authentication is complete, App component will handle redirect to main page
  };

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <LoginForm
            onSwitchToSignUp={handleSwitchToSignUp}
            onSwitchToForgotPassword={handleSwitchToForgotPassword}
          />
        }
      />
      <Route
        path="/signup"
        element={
          isSelfSignUpEnabled ? (
            <SignUpForm onSwitchToLogin={handleSwitchToLogin} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/confirm"
        element={
          <ConfirmSignUpForm
            username={pendingUsername || ''}
            onSwitchToLogin={handleSwitchToLogin}
            onBack={handleBackToSignUp ?? handleSwitchToLogin}
          />
        }
      />
      <Route
        path="/forgot-password"
        element={
          <ForgotPasswordForm
            onSwitchToLogin={handleSwitchToLogin}
            onCodeSent={handleForgotPasswordCodeSent}
          />
        }
      />
      <Route
        path="/reset-password"
        element={
          <ResetPasswordForm
            email={resetPasswordEmail}
            onSuccess={handleResetPasswordSuccess}
            onBack={handleResetPasswordBack}
          />
        }
      />
      <Route
        path="/force-change-password"
        element={<ForceChangePasswordForm onSuccess={handleForceChangePasswordSuccess} />}
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
};
