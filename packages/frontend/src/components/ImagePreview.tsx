import React from 'react';
import { X } from 'lucide-react';
import type { ImageAttachment } from '../types/index';

interface ImagePreviewProps {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const ImagePreview: React.FC<ImagePreviewProps> = ({ images, onRemove, disabled }) => {
  if (images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 p-2 border-b border-border">
      {images.map((image) => (
        <div key={image.id} className="relative group">
          <img
            src={image.previewUrl}
            alt={image.fileName}
            className="w-20 h-20 object-cover rounded-lg border border-border"
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => onRemove(image.id)}
              className="absolute -top-2 -right-2 w-5 h-5 bg-gray-800 bg-opacity-70 hover:bg-opacity-90 rounded-full flex items-center justify-center text-white transition-opacity"
              aria-label={`Remove ${image.fileName}`}
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs px-1 py-0.5 rounded-b-lg truncate">
            {formatFileSize(image.size)}
          </div>
        </div>
      ))}
    </div>
  );
};
