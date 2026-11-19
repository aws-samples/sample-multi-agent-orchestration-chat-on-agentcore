import { useTranslation } from 'react-i18next';
import { PanelRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useFilePreviewStore } from '../../stores/filePreviewStore';

export function FilePreviewToggle() {
  const { t } = useTranslation();
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const hasFile = useFilePreviewStore((s) => s.path !== null);
  const toggle = useFilePreviewStore((s) => s.toggle);
  const label = isOpen ? t('chat.filePreview.hide') : t('chat.filePreview.show');

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={isOpen}
      className={cn(
        'relative grid size-8 place-items-center rounded-lg text-fg-secondary transition-colors',
        'hover:bg-surface-secondary hover:text-fg-default',
        isOpen && 'bg-surface-secondary text-fg-default'
      )}
    >
      <PanelRight className="size-4" aria-hidden />
      {/* A file is waiting in the hidden dock. */}
      {!isOpen && hasFile && (
        <span
          className="absolute right-1 top-1 size-2 rounded-full border-[1.5px] border-surface-primary bg-action-primary"
          aria-hidden
        />
      )}
    </button>
  );
}
