// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { HtmlViewer } from '../HtmlViewer';
import { sandboxCsp } from '../../../../utils/htmlSandbox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // TextViewers pulls in the app's i18n setup through the Markdown components.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const HTML = '<!DOCTYPE html><html><body><h1>Report</h1></body></html>';

function frame() {
  return screen.queryByTitle('storage.preview.htmlFrameTitle');
}

describe('HtmlViewer', () => {
  it('renders in an iframe sandboxed to allow-scripts only', () => {
    render(<HtmlViewer text={HTML} truncated={false} />);
    const iframe = frame();
    expect(iframe).not.toBeNull();
    // Exact match: allow-same-origin (or popups/top-navigation) must never creep in.
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(iframe!.getAttribute('srcdoc')).toContain(sandboxCsp(false));
  });

  it('switches between rendered and source views', () => {
    render(<HtmlViewer text={HTML} truncated={false} />);
    fireEvent.click(screen.getByText('storage.preview.source'));
    expect(frame()).toBeNull();
    expect(screen.getByText('Report', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByText('storage.preview.rendered'));
    expect(frame()).not.toBeNull();
  });

  it('asks for confirmation before loading remote resources', async () => {
    render(<HtmlViewer text={HTML} truncated={false} />);
    fireEvent.click(screen.getByText('storage.preview.htmlRemote'));
    // Nothing is loaded yet: the dialog is up and the CSP is still local-only.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('common.cancel')).toHaveFocus();
    expect(frame()!.getAttribute('srcdoc')).toContain(sandboxCsp(false));

    fireEvent.click(screen.getByText('storage.preview.htmlRemoteConfirmAction'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(frame()!.getAttribute('srcdoc')).toContain(sandboxCsp(true));
    // The warning is a hover reminder only, not a standing banner.
    expect(screen.queryByText('storage.preview.htmlRemoteWarning')).toBeNull();
    fireEvent.mouseOver(screen.getByText('storage.preview.htmlRemote'));
    expect(await screen.findByText('storage.preview.htmlRemoteWarning')).toBeInTheDocument();
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByText('common.cancel'))],
    ['Esc', () => fireEvent.keyDown(screen.getByText('common.cancel'), { key: 'Escape' })],
  ])('keeps remote resources blocked on %s', (_, dismiss) => {
    render(<HtmlViewer text={HTML} truncated={false} />);
    fireEvent.click(screen.getByText('storage.preview.htmlRemote'));
    dismiss();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(frame()!.getAttribute('srcdoc')).toContain(sandboxCsp(false));
  });

  it('does not let Esc in the dialog reach document-level listeners (the storage Modal)', () => {
    const onDocumentKey = vi.fn();
    document.addEventListener('keydown', onDocumentKey);
    render(<HtmlViewer text={HTML} truncated={false} />);
    fireEvent.click(screen.getByText('storage.preview.htmlRemote'));
    fireEvent.keyDown(screen.getByText('common.cancel'), { key: 'Escape' });
    document.removeEventListener('keydown', onDocumentKey);
    expect(onDocumentKey).not.toHaveBeenCalled();
  });

  it('turns remote resources off without asking', () => {
    render(<HtmlViewer text={HTML} truncated={false} />);
    fireEvent.click(screen.getByText('storage.preview.htmlRemote'));
    fireEvent.click(screen.getByText('storage.preview.htmlRemoteConfirmAction'));
    fireEvent.click(screen.getByText('storage.preview.htmlRemote'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(frame()!.getAttribute('srcdoc')).toContain(sandboxCsp(false));
  });

  it('shows only the source when the file was truncated', () => {
    render(<HtmlViewer text="<html><body><div>cut" truncated />);
    expect(frame()).toBeNull();
    expect(screen.queryByText('storage.preview.rendered')).toBeNull();
    expect(screen.getByText(/storage\.preview\.htmlSourceOnly/)).toBeInTheDocument();
  });
});
