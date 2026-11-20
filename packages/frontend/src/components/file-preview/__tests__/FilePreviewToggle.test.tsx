// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FilePreviewToggle } from '../FilePreviewToggle';
import { ChatFilePreviewDock } from '../ChatFilePreviewDock';
import { useFilePreviewStore } from '../../../stores/filePreviewStore';
import { useChatStore } from '../../../stores/chatStore';
import type { Message } from '../../../types/index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../i18n', () => ({ default: { t: (key: string) => key } }));
// The dock body renders real previews; only whether the dock shows matters here.
vi.mock('../../storage/preview/FilePreviewBody', () => ({ FilePreviewBody: () => null }));
vi.mock('../../storage/preview/PreviewHeader', () => ({ PreviewHeader: () => null }));

const SESSION = 'session-1';

function showMessages(...texts: string[]) {
  const messages: Message[] = texts.map((text, i) => ({
    id: `m${i}`,
    type: 'assistant',
    contents: [{ type: 'text', text }],
    timestamp: new Date(),
  }));
  act(() =>
    useChatStore.setState({
      activeSessionId: SESSION,
      sessions: { [SESSION]: { messages, isLoading: false, error: null, lastUpdated: new Date() } },
    })
  );
}

function renderChrome() {
  const ref = { current: null };
  return render(
    <>
      <FilePreviewToggle />
      <ChatFilePreviewDock chatColumnRef={ref} />
    </>
  );
}

const toggle = () => screen.queryByRole('button', { name: /chat\.filePreview\.(show|hide)/ });
const dock = () => screen.queryByRole('complementary');

beforeEach(() => {
  useFilePreviewStore.setState({ isOpen: false, path: null, emptyRequested: false });
  useChatStore.setState({ activeSessionId: null, sessions: {} });
});

describe('file preview toggle and dock visibility', () => {
  it('shows neither in a conversation without file links, even if the dock was left open', () => {
    useFilePreviewStore.setState({ isOpen: true });
    showMessages('no files here, see [docs](https://example.com)');
    renderChrome();

    expect(toggle()).not.toBeInTheDocument();
    expect(dock()).not.toBeInTheDocument();
  });

  it('shows the toggle once the conversation links a file, without popping open an empty dock', () => {
    useFilePreviewStore.setState({ isOpen: true }); // persisted preference
    renderChrome();
    showMessages('Saved to [report](/docs/report.md).');

    expect(toggle()).toBeInTheDocument();
    expect(dock()).not.toBeInTheDocument();
  });

  it('opens the empty dock when the user asks for it', () => {
    showMessages('Saved to [report](/docs/report.md).');
    renderChrome();

    fireEvent.click(toggle()!);

    expect(dock()).toBeInTheDocument();
  });

  it('shows the dock with a loaded file', () => {
    renderChrome();
    act(() => useFilePreviewStore.getState().open('/docs/report.md'));

    expect(toggle()).toBeInTheDocument();
    expect(dock()).toBeInTheDocument();
  });

  it('ignores video links, which play inline instead of opening the dock', () => {
    showMessages('[clip](/videos/demo.mp4)');
    renderChrome();

    expect(toggle()).not.toBeInTheDocument();
  });
});
