// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { S3FileLink } from '../S3FileLink';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../api/storage', () => ({
  generateDownloadUrl: vi.fn(async () => 'https://s3.example.test/presigned'),
}));
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn() },
}));

function renderLink(onOpen?: (path: string) => void) {
  render(
    <S3FileLink path="/kaisei/修正一覧.md" onOpen={onOpen}>
      修正一覧.md
    </S3FileLink>
  );
  return screen.getByRole('link');
}

describe('S3FileLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the file in-app on a plain click without prefetching a URL', async () => {
    const { generateDownloadUrl } = await import('../../api/storage');
    const onOpen = vi.fn();
    const notPrevented = fireEvent.click(renderLink(onOpen));
    expect(onOpen).toHaveBeenCalledWith('/kaisei/修正一覧.md');
    expect(notPrevented).toBe(false);
    expect(generateDownloadUrl).not.toHaveBeenCalled();
  });

  it.each(['metaKey', 'ctrlKey', 'shiftKey'])(
    'fetches a URL into a new tab on %s+click',
    async (key) => {
      const { generateDownloadUrl } = await import('../../api/storage');
      const tab = { closed: false, location: { href: '' } };
      vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      const onOpen = vi.fn();
      fireEvent.click(renderLink(onOpen), { [key]: true });
      expect(onOpen).not.toHaveBeenCalled();
      expect(generateDownloadUrl).toHaveBeenCalledWith('/kaisei/修正一覧.md', { inline: true });
      await waitFor(() => expect(tab.location.href).toBe('https://s3.example.test/presigned'));
    }
  );

  it('follows the prefetched href when no in-app handler is given', async () => {
    const link = renderLink();
    await waitFor(() => expect(link).toHaveAttribute('href', 'https://s3.example.test/presigned'));
    expect(fireEvent.click(link)).toBe(true);
  });
});

describe('S3FileLink href disposition', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['/kaisei/修正一覧.md', true],
    ['/out/report.pdf', true],
    ['/out/archive.zip', false],
    ['/out/page.html', false],
  ])('%s → inline=%s', async (path, inline) => {
    const { generateDownloadUrl } = await import('../../api/storage');
    render(<S3FileLink path={path}>x</S3FileLink>);
    await waitFor(() => expect(generateDownloadUrl).toHaveBeenCalledWith(path, { inline }));
  });
});
