import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2, Paperclip, CheckCircle2 } from 'lucide-react';
import { randomId } from '../utils/randomId';
import { useChatStore } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useStorageStore } from '../stores/storageStore';
import * as storageApi from '../api/storage';
import { StoragePathDisplay } from './StoragePathDisplay';
import { StorageManagementModal } from './StorageManagementModal';
import { ModelReasoningSelector } from './ui/ModelReasoningSelector';
import { ImagePreview } from './ImagePreview';
import type { ImageAttachment } from '../types/index';
import { IMAGE_ATTACHMENT_CONFIG } from '../types/index';
import { logger } from '../utils/logger';

interface MessageInputProps {
  sessionId: string | null;
  onCreateSession: () => string;
  getScenarioPrompt?: () => string | null;
}

export const MessageInput: React.FC<MessageInputProps> = ({
  sessionId,
  onCreateSession,
  getScenarioPrompt,
}) => {
  const { t } = useTranslation();
  const { sendPrompt } = useChatStore();
  const { sendBehavior } = useSettingsStore();
  const sessionState = useChatStore((state) =>
    sessionId ? (state.sessions[sessionId] ?? null) : null
  );
  const isLoading = sessionState?.isLoading || false;
  const isAgentStoreLoading = useAgentStore((state) => state.isLoading);
  const isWideView = useUIStore((state) => state.isWideView);
  const agentWorkingDirectory = useStorageStore((state) => state.agentWorkingDirectory);
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const [isStorageModalOpen, setIsStorageModalOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  // Brief "upload complete" message shown in the same spot as the uploading
  // overlay, right after it disappears. null when nothing to show.
  const [uploadDoneMessage, setUploadDoneMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevLoadingRef = useRef(isLoading);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the completion-message timer on unmount
  useEffect(() => {
    return () => {
      if (doneTimerRef.current) {
        clearTimeout(doneTimerRef.current);
      }
    };
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Return focus when loading completes
  useEffect(() => {
    // Return focus when loading completes (true → false)
    if (prevLoadingRef.current && !isLoading) {
      textareaRef.current?.focus();
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading]);

  // Listen for focus event from command palette
  useEffect(() => {
    const handleFocusEvent = () => {
      textareaRef.current?.focus();
    };
    window.addEventListener('focusMessageInput', handleFocusEvent);
    return () => {
      window.removeEventListener('focusMessageInput', handleFocusEvent);
    };
  }, []);

  // Validate image file
  const validateImageFile = useCallback(
    (file: File): string | null => {
      if (!IMAGE_ATTACHMENT_CONFIG.ACCEPTED_TYPES.includes(file.type as never)) {
        return t('chat.imageAttachment.invalidType');
      }
      if (file.size >= IMAGE_ATTACHMENT_CONFIG.MAX_FILE_SIZE) {
        return t('chat.imageAttachment.tooLarge');
      }
      return null;
    },
    [t]
  );

  // Validate total size
  const validateTotalSize = useCallback(
    (currentImages: ImageAttachment[], newFiles: File[]): string | null => {
      const currentTotal = currentImages.reduce((sum, img) => sum + img.size, 0);
      const newTotal = newFiles.reduce((sum, file) => sum + file.size, 0);
      if (currentTotal + newTotal > IMAGE_ATTACHMENT_CONFIG.MAX_TOTAL_SIZE) {
        return t('chat.imageAttachment.totalSizeExceeded');
      }
      return null;
    },
    [t]
  );

  // Process and attach image files
  const processAndAttachImages = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const remainingSlots = IMAGE_ATTACHMENT_CONFIG.MAX_COUNT - attachedImages.length;

      if (remainingSlots <= 0) {
        alert(t('chat.imageAttachment.maxReached'));
        return;
      }

      const filesToProcess = fileArray.slice(0, remainingSlots);

      // Validate individual files
      const validFiles: File[] = [];
      for (const file of filesToProcess) {
        const error = validateImageFile(file);
        if (error) {
          alert(`${file.name}: ${error}`);
          continue;
        }
        validFiles.push(file);
      }

      // Validate total size
      const totalSizeError = validateTotalSize(attachedImages, validFiles);
      if (totalSizeError) {
        alert(totalSizeError);
        return;
      }

      const newImages: ImageAttachment[] = [];
      for (const file of validFiles) {
        const previewUrl = URL.createObjectURL(file);
        newImages.push({
          id: randomId(),
          file,
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          previewUrl,
        });
      }

      if (newImages.length > 0) {
        setAttachedImages((prev) => [...prev, ...newImages]);
      }
    },
    [attachedImages, validateImageFile, validateTotalSize, t]
  );

  // Remove image
  const handleRemoveImage = useCallback((id: string) => {
    setAttachedImages((prev) => {
      const imageToRemove = prev.find((img) => img.id === id);
      if (imageToRemove?.previewUrl) {
        URL.revokeObjectURL(imageToRemove.previewUrl);
      }
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  // Handle file input change
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processAndAttachImages(e.target.files);
        e.target.value = '';
      }
    },
    [processAndAttachImages]
  );

  // Insert text at the textarea cursor (falls back to appending). Keeps the
  // caret right after the inserted text so the user can keep typing.
  const insertTextAtCursor = useCallback((text: string) => {
    setInput((prev) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? prev.length;
      const end = textarea?.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + text + prev.slice(end);
      // Restore the caret after React commits the new value
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          const pos = start + text.length;
          el.focus();
          el.setSelectionRange(pos, pos);
        }
      });
      return next;
    });
  }, []);

  // Join a directory and file name into a normalized absolute path
  const joinWorkingPath = useCallback((dir: string, fileName: string): string => {
    if (!dir || dir === '/') {
      return `/${fileName}`;
    }
    const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    return `${trimmed}/${fileName}`;
  }, []);

  // Upload non-image files to the current agent working directory and insert
  // their resulting paths into the message input. Uploads sequentially so the
  // inserted paths keep the drop order.
  const uploadFilesToWorkingDirectory = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const maxSize = 500 * 1024 * 1024; // 500MB (matches storage store limit)
      let uploadedCount = 0;
      try {
        for (const file of files) {
          if (file.size > maxSize) {
            alert(t('chat.fileDrop.tooLarge', { name: file.name }));
            continue;
          }
          try {
            setUploadingFileName(file.name);
            const { uploadUrl } = await storageApi.generateUploadUrl(
              file.name,
              agentWorkingDirectory,
              file.type
            );
            await storageApi.uploadFileToS3(uploadUrl, file);

            const uploadedPath = joinWorkingPath(agentWorkingDirectory, file.name);
            insertTextAtCursor(`${uploadedPath} `);
            uploadedCount++;
          } catch (error) {
            logger.error('Failed to upload dropped file %s:', file.name, error);
            alert(
              t('chat.fileDrop.failed', {
                name: file.name,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        }
        // Refresh the storage modal view/tree so the new files show up
        await useStorageStore.getState().loadFolderTree();
        if (useStorageStore.getState().currentPath === agentWorkingDirectory) {
          await useStorageStore.getState().loadItems(agentWorkingDirectory);
        }
      } finally {
        setUploadingFileName(null);
        // Briefly show a completion message in the same spot, then hide it.
        if (uploadedCount > 0) {
          setUploadDoneMessage(t('chat.fileDrop.uploaded', { count: uploadedCount }));
          if (doneTimerRef.current) {
            clearTimeout(doneTimerRef.current);
          }
          doneTimerRef.current = setTimeout(() => {
            setUploadDoneMessage(null);
            doneTimerRef.current = null;
          }, 1000);
        }
      }
    },
    [agentWorkingDirectory, insertTextAtCursor, joinWorkingPath, t]
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // Images keep the existing "attach to message" behavior; every other file
      // is uploaded to the working directory and its path inserted into the input.
      const imageFiles = files.filter((file) =>
        IMAGE_ATTACHMENT_CONFIG.ACCEPTED_TYPES.includes(file.type as never)
      );
      const otherFiles = files.filter(
        (file) => !IMAGE_ATTACHMENT_CONFIG.ACCEPTED_TYPES.includes(file.type as never)
      );

      if (imageFiles.length > 0) {
        processAndAttachImages(imageFiles);
      }
      if (otherFiles.length > 0) {
        void uploadFilesToWorkingDirectory(otherFiles);
      }
    },
    [processAndAttachImages, uploadFilesToWorkingDirectory]
  );

  // Handle paste from clipboard (screenshots)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault(); // Prevent image data from being pasted as text
        processAndAttachImages(imageFiles);
      }
      // Allow normal text paste if no images
    },
    [processAndAttachImages]
  );

  // Cleanup: Release Object URLs on component unmount
  useEffect(() => {
    return () => {
      attachedImages.forEach((img) => {
        if (img.previewUrl) {
          URL.revokeObjectURL(img.previewUrl);
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fill scenario prompt
  useEffect(() => {
    if (getScenarioPrompt) {
      const scenarioPrompt = getScenarioPrompt();
      if (scenarioPrompt) {
        // Execute in next frame to prevent cascade rendering
        requestAnimationFrame(() => {
          setInput(scenarioPrompt);
          // Focus and move cursor to end
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.setSelectionRange(scenarioPrompt.length, scenarioPrompt.length);
            }
          }, 0);
        });
      }
    }
  }, [getScenarioPrompt]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Clear only if error exists (prevent unnecessary re-renders)
    // Error cleared on send or new message, so delete here
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const hasContent = input.trim() || attachedImages.length > 0;
    if (!hasContent || isLoading || isAgentStoreLoading) {
      return;
    }

    try {
      // Save message to send
      const messageToSend = input.trim();
      const imagesToSend = [...attachedImages];

      // Clear input field immediately
      setInput('');
      setAttachedImages([]);

      // Return focus to textarea after sending
      textareaRef.current?.focus();

      // Create session first for new session
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        targetSessionId = onCreateSession();
      }

      // Send message (continue asynchronously)
      await sendPrompt(messageToSend, targetSessionId, imagesToSend);

      // Release Object URLs after sending
      imagesToSend.forEach((img) => {
        if (img.previewUrl) {
          URL.revokeObjectURL(img.previewUrl);
        }
      });
    } catch (err) {
      logger.error('Message send error:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Do nothing during IME composition
    if (e.nativeEvent.isComposing) {
      return;
    }

    if (sendBehavior === 'enter') {
      // Send with Enter, newline with Shift+Enter
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    } else {
      // Send with Cmd/Ctrl+Enter, newline with Enter
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit(e);
      }
    }
  };

  return (
    <div
      className="sticky bottom-0 left-0 right-0 z-30 bg-surface-primary p-4"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      {/* Storage path display */}
      <div
        className={`${isWideView ? 'max-w-full px-4' : 'max-w-4xl'} mx-auto mb-2 transition-[max-width,padding] duration-300 ease-in-out`}
      >
        <StoragePathDisplay onClick={() => setIsStorageModalOpen(true)} />
      </div>

      <form
        onSubmit={handleSubmit}
        className={`${isWideView ? 'max-w-full px-4' : 'max-w-4xl'} mx-auto transition-[max-width,padding] duration-300 ease-in-out`}
      >
        <div
          className={`relative ${isDragging ? 'ring-2 ring-blue-400 ring-opacity-50 rounded-2xl' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Upload status overlay for dropped files: shows progress while
              uploading, then a brief completion message in the same spot. */}
          {uploadingFileName ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-start gap-2 rounded-2xl bg-surface-primary/80 px-4 text-sm text-fg-secondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('chat.fileDrop.uploading', { name: uploadingFileName })}</span>
            </div>
          ) : (
            uploadDoneMessage && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-start gap-2 rounded-2xl bg-surface-primary/80 px-4 text-sm text-fg-secondary">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span>{uploadDoneMessage}</span>
              </div>
            )
          )}

          {/* Image preview */}
          <ImagePreview images={attachedImages} onRemove={handleRemoveImage} disabled={isLoading} />

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ATTACHMENT_CONFIG.ACCEPTED_TYPES.join(',')}
            multiple
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Text input + toolbar live in one bordered box. The toolbar is a
              normal flex row (not absolute) so the left controls and the send
              button can never overlap: the left group shrinks/scrolls while the
              send button keeps its fixed width at the right edge. */}
          <div className="border border-border rounded-2xl bg-surface-primary focus-within:ring-1 focus-within:ring-gray-200">
            {/* Text input area - Reserve space for 2 rows */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('chat.messageInputPlaceholder')}
              className="w-full px-4 py-3 bg-transparent border-0 focus:outline-none resize-none min-h-[60px] max-h-[200px]"
              rows={2}
              style={{ height: 'auto' }}
            />

            {/* Bottom toolbar row */}
            <div className="flex items-center gap-1 px-2 pb-2">
              {/* Left controls. `min-w-0` lets this group shrink so the send
                  button keeps its place; NOTE: no `overflow-*` here — it would
                  also clip overflow-y and hide the upward-opening model/depth
                  dropdowns (they render with `absolute bottom-full`). */}
              <div className="flex items-center gap-1 min-w-0">
                <ModelReasoningSelector />
                {/* Image attachment button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading || attachedImages.length >= IMAGE_ATTACHMENT_CONFIG.MAX_COUNT}
                  className={`shrink-0 p-1.5 rounded-md transition-colors ${
                    isLoading || attachedImages.length >= IMAGE_ATTACHMENT_CONFIG.MAX_COUNT
                      ? 'text-fg-disabled cursor-not-allowed'
                      : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-secondary'
                  }`}
                  title={t('chat.imageAttachment.attach')}
                >
                  <Paperclip className="w-4 h-4" />
                </button>
              </div>

              {/* Send button - fixed width, pinned to the right, never overlapped. */}
              <button
                type="submit"
                disabled={
                  (!input.trim() && attachedImages.length === 0) || isLoading || isAgentStoreLoading
                }
                className={`ml-auto shrink-0 w-8 h-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                  (!input.trim() && attachedImages.length === 0) || isLoading || isAgentStoreLoading
                    ? 'text-fg-disabled cursor-not-allowed'
                    : 'text-black hover:bg-surface-secondary'
                }`}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </form>

      {/* Storage management modal */}
      <StorageManagementModal
        isOpen={isStorageModalOpen}
        onClose={() => setIsStorageModalOpen(false)}
      />
    </div>
  );
};
