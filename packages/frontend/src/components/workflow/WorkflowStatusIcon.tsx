import React from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleSlash,
  CircleX,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  isActiveStatus,
  statusTone,
  type AnyWorkflowStatus as AnyStatus,
} from '../../utils/workflow-status';

const ICONS: Record<AnyStatus, LucideIcon> = {
  pending: CircleDashed,
  running: Loader2,
  reviewing: Loader2,
  done: CircleCheck,
  completed: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
  cancelled: CircleSlash,
};

export const WorkflowStatusIcon: React.FC<{ status: AnyStatus; className?: string }> = ({
  status,
  className,
}) => {
  const Icon = ICONS[status] ?? CircleDashed;
  return (
    <Icon
      className={cn(
        'size-3.5 shrink-0',
        statusTone(status),
        isActiveStatus(status) && 'animate-spin',
        className
      )}
      aria-hidden
    />
  );
};
