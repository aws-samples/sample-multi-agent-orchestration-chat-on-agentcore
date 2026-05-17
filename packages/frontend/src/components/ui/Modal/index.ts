import { Modal as ModalRoot } from './Modal';
import { ModalHeader, ModalIcon, ModalTitle, ModalCloseButton } from './ModalHeader';
import { ModalContent } from './ModalContent';
import { ModalFooter } from './ModalFooter';
import { ConfirmModal } from './ConfirmModal';

// Export using Compound Components pattern
export const Modal = Object.assign(ModalRoot, {
  Header: ModalHeader,
  Icon: ModalIcon,
  Title: ModalTitle,
  CloseButton: ModalCloseButton,
  Content: ModalContent,
  Footer: ModalFooter,
});

// Individual exports (as needed)
export { ModalRoot };
export { ModalHeader, ModalIcon, ModalTitle, ModalCloseButton };
export { ModalContent };
export { ModalFooter };
export { ConfirmModal };

// Type exports
export type * from './types';
