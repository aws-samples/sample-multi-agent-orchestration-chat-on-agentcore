import { useTranslation } from 'react-i18next';
import { formatBytes } from '../../../utils/formatBytes';
import { TEXT_PREVIEW_MAX_BYTES } from './useFileText';

export function useTruncatedNotice(truncated: boolean): string | null {
  const { t } = useTranslation();
  return truncated
    ? t('storage.preview.truncated', { size: formatBytes(TEXT_PREVIEW_MAX_BYTES) })
    : null;
}
