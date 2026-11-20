// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FilePreviewToggle } from '../FilePreviewToggle';
import { S3FileLink } from '../../S3FileLink';
import { useFilePreviewStore } from '../../../stores/filePreviewStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../api/storage', () => ({ generateDownloadUrl: vi.fn() }));

beforeEach(() => {
  useFilePreviewStore.setState({ isOpen: false, path: null, linkCount: 0 });
});

const toggle = () => screen.queryByRole('button', { name: /chat\.filePreview\./ });

describe('FilePreviewToggle visibility', () => {
  it('is hidden in a conversation without file links', () => {
    render(<FilePreviewToggle />);
    expect(toggle()).not.toBeInTheDocument();
  });

  it('is hidden even when the dock preference is open', () => {
    useFilePreviewStore.setState({ isOpen: true });
    render(<FilePreviewToggle />);
    expect(toggle()).not.toBeInTheDocument();
  });

  it('appears while an in-app file link is rendered and goes away with it', () => {
    const { rerender } = render(
      <>
        <FilePreviewToggle />
        <S3FileLink path="/docs/report.md" onOpen={vi.fn()}>
          report.md
        </S3FileLink>
      </>
    );
    expect(toggle()).toBeInTheDocument();

    rerender(<FilePreviewToggle />);
    expect(toggle()).not.toBeInTheDocument();
  });

  it('does not count links that open outside the app', () => {
    render(
      <>
        <FilePreviewToggle />
        <S3FileLink path="/docs/report.md">report.md</S3FileLink>
      </>
    );
    expect(toggle()).not.toBeInTheDocument();
  });

  it('stays while a file is loaded in the dock', () => {
    render(<FilePreviewToggle />);
    act(() => useFilePreviewStore.setState({ path: '/docs/report.md' }));
    expect(toggle()).toBeInTheDocument();
  });
});
