/**
 * File Icon Utilities
 * Utility for returning icons and colors based on file extension
 */

import {
  File,
  FileText,
  FileSpreadsheet,
  Image,
  FileCode,
  FileJson,
  FileArchive,
  FileVideo,
  FileAudio,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

interface FileIconConfig {
  icon: LucideIcon;
  color: string;
}

/**
 * Get file extension from file name
 */
function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  if (parts.length > 1) {
    return parts[parts.length - 1].toLowerCase();
  }
  return '';
}

/**
 * Get icon and color from file extension
 */
export function getFileIcon(filename: string): FileIconConfig {
  const ext = getFileExtension(filename);

  // Documents
  if (ext === 'pdf') {
    return { icon: FileText, color: 'text-feedback-error' };
  }
  if (['doc', 'docx'].includes(ext)) {
    return { icon: FileText, color: 'text-action-primary' };
  }
  if (['txt', 'md', 'markdown'].includes(ext)) {
    return { icon: FileText, color: 'text-fg-muted' };
  }

  // Spreadsheets
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return { icon: FileSpreadsheet, color: 'text-green-500' };
  }

  // Presentations
  if (['ppt', 'pptx', 'pptm', 'odp', 'key'].includes(ext)) {
    return { icon: Presentation, color: 'text-orange-500' };
  }

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) {
    return { icon: Image, color: 'text-purple-500' };
  }

  // Code (JavaScript/TypeScript)
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    return { icon: FileCode, color: 'text-yellow-500' };
  }

  // Code (Python)
  if (['py', 'pyc', 'pyd', 'pyw'].includes(ext)) {
    return { icon: FileCode, color: 'text-action-primary' };
  }

  // Code (Web)
  if (['html', 'htm', 'css', 'scss', 'sass', 'less'].includes(ext)) {
    return { icon: FileCode, color: 'text-orange-500' };
  }

  // Code (Other)
  if (
    ['java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift', 'kt', 'rb', 'php'].includes(ext)
  ) {
    return { icon: FileCode, color: 'text-cyan-500' };
  }

  // JSON/YAML
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return { icon: FileJson, color: 'text-orange-600' };
  }

  // Archives
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(ext)) {
    return { icon: FileArchive, color: 'text-amber-700' };
  }

  // Videos
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'].includes(ext)) {
    return { icon: FileVideo, color: 'text-purple-600' };
  }

  // Audio
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) {
    return { icon: FileAudio, color: 'text-teal-500' };
  }

  // Default (unknown extension)
  return { icon: File, color: 'text-action-primary' };
}
