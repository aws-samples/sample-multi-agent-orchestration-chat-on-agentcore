/**
 * Folder Tree Component
 * Recursive folder tree display component
 */

import { ChevronRight, ChevronDown, Folder, FolderOpen, FolderCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FolderNode } from '../api/storage';

interface TreeNodeProps {
  node: FolderNode;
  level: number;
  selectedPath: string;
  workingDirectoryPath?: string;
  expandedPaths: string[];
  onSelect: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, node: FolderNode) => void;
}

function TreeNode({
  node,
  level,
  selectedPath,
  workingDirectoryPath,
  expandedPaths,
  onSelect,
  onToggleExpand,
  onContextMenu,
}: TreeNodeProps) {
  const isExpanded = expandedPaths.includes(node.path);
  const isSelected = selectedPath === node.path;
  const isWorkingDirectory = workingDirectoryPath === node.path;
  const hasChildren = node.children && node.children.length > 0;

  const handleClick = () => {
    onSelect(node.path);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      onToggleExpand(node.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) {
      onContextMenu(e, node);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer hover:bg-surface-secondary transition-colors ${
          isSelected ? 'bg-feedback-info-bg text-action-primary' : 'text-fg-secondary'
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Expand/collapse icon */}
        <button
          onClick={handleToggle}
          className={`p-0.5 hover:bg-border rounded transition-colors ${
            !hasChildren ? 'invisible' : ''
          }`}
        >
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        {/* Folder icon */}
        {isWorkingDirectory ? (
          <FolderCog className="w-4 h-4 text-amber-500" />
        ) : isExpanded ? (
          <FolderOpen className="w-4 h-4 text-amber-500" />
        ) : (
          <Folder className="w-4 h-4 text-amber-500" />
        )}

        {/* Folder name */}
        <span className="text-sm truncate">{node.name}</span>
      </div>

      {/* Child nodes (only shown when expanded) */}
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              workingDirectoryPath={workingDirectoryPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FolderTreeProps {
  tree: FolderNode[];
  selectedPath: string;
  workingDirectoryPath?: string;
  expandedPaths: string[];
  onSelect: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, node: FolderNode) => void;
  isLoading?: boolean;
}

export function FolderTree({
  tree,
  selectedPath,
  workingDirectoryPath,
  expandedPaths,
  onSelect,
  onToggleExpand,
  onContextMenu,
  isLoading,
}: FolderTreeProps) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-sm text-fg-muted">{t('common.loading')}</div>
      </div>
    );
  }

  if (!tree || tree.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-sm text-fg-muted">{t('common.noFolders')}</div>
      </div>
    );
  }

  return (
    <div className="py-2">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          level={0}
          selectedPath={selectedPath}
          workingDirectoryPath={workingDirectoryPath}
          expandedPaths={expandedPaths}
          onSelect={onSelect}
          onToggleExpand={onToggleExpand}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}
