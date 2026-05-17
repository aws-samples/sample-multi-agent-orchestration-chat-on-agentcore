import React from 'react';
import { Modal } from './index';
import { Button } from '../Button';
import type { ConfirmModalProps } from './types';

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '確認',
  cancelText = 'キャンセル',
  variant = 'default',
}) => {
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
          {cancelText}
        </Button>
        <Button
          variant={variant === 'danger' ? 'danger' : 'primary'}
          size="md"
          onClick={handleConfirm}
        >
          {confirmText}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
