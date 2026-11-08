import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './index';
import { Button } from '../Button';
import type { ConfirmModalProps } from './types';

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
  variant = 'default',
}) => {
  const { t } = useTranslation();
  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <Modal.Header>
        <Modal.Title>{title}</Modal.Title>
        <Modal.CloseButton />
      </Modal.Header>

      <Modal.Content>
        <p className="text-sm text-fg-secondary">{message}</p>
      </Modal.Content>

      <Modal.Footer>
        <Button variant="outline" size="md" onClick={onClose}>
          {cancelText ?? t('common.cancel')}
        </Button>
        <Button
          variant={variant === 'danger' ? 'danger' : 'primary'}
          size="md"
          onClick={handleConfirm}
        >
          {confirmText ?? t('common.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
