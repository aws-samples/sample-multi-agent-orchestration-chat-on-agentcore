/**
 * Storage Path Display
 * Displays user storage path and opens modal on click
 */

import { Folder } from 'lucide-react';
import { useStorageStore } from '../stores/storageStore';

interface StoragePathDisplayProps {
  onClick: () => void;
}

export function StoragePathDisplay({ onClick }: StoragePathDisplayProps) {
  const { agentWorkingDirectory } = useStorageStore();

  // Display shortened path (max 40 characters)
  const displayPath =
    agentWorkingDirectory.length > 40
      ? '...' + agentWorkingDirectory.slice(-37)
      : agentWorkingDirectory;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 text-sm text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded-lg transition-all duration-200 group"
      title={`Storage: ${agentWorkingDirectory}`}
    >
      <Folder
        fill="rgb(253, 230, 138)"
        className="w-4 h-4 text-amber-400 group-hover:text-amber-500 transition-colors"
      />
      <span className="font-mono text-xs">{displayPath}</span>
    </button>
  );
}
