/**
 * Shortcuts Help Modal
 *
 * Displays a read-only list of keyboard shortcuts available in the app.
 * Triggered by Cmd+/ (macOS) / Ctrl+/ (Windows, Linux) via useShortcutsHelp.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal';
import { SHORTCUT_GROUPS, formatShortcut } from '../config/shortcuts';

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const isMac = useMemo(() => isMacPlatform(), []);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <Modal.Header>
        <Modal.Title>{t('shortcuts.title')}</Modal.Title>
        <Modal.CloseButton />
      </Modal.Header>

      <Modal.Content>
        <p className="text-sm text-fg-muted mb-6">{t('shortcuts.description')}</p>

        <div className="space-y-6">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.titleKey}>
              <h2 className="text-xs font-medium text-fg-muted uppercase tracking-wide mb-3">
                {t(group.titleKey)}
              </h2>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const tokens = formatShortcut(item.keys, isMac);
                  return (
                    <li
                      key={item.labelKey}
                      className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-surface-secondary transition-colors"
                    >
                      <span className="text-sm text-fg-default">{t(item.labelKey)}</span>
                      <span className="flex items-center gap-1">
                        {tokens.map((token, index) => (
                          <kbd
                            key={index}
                            className="px-2 py-0.5 min-w-[1.75rem] text-center text-xs font-medium text-fg-secondary bg-surface-secondary border border-border rounded"
                          >
                            {token}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </Modal.Content>
    </Modal>
  );
};
