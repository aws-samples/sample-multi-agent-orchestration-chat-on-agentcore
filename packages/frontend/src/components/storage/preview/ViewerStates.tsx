import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '../../../lib/utils';

interface StateProps {
  tone?: 'light' | 'dark';
  className?: string;
}

export function ViewerLoading({ tone = 'light', className }: StateProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center gap-2',
        tone === 'dark' ? 'text-white/70' : 'text-fg-secondary',
        className
      )}
    >
      <Loader2 className="h-6 w-6 animate-spin" />
      <span className="text-sm">{t('common.loading')}</span>
    </div>
  );
}

export function ViewerError({
  message,
  tone = 'light',
  className,
}: StateProps & { message: string }) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-2',
        tone === 'dark' ? 'text-white/70' : 'text-fg-secondary',
        className
      )}
    >
      <AlertCircle className="h-8 w-8 text-feedback-error" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
