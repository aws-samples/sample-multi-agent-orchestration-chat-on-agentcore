// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { JsonRenderBlock } from '../JsonRenderBlock';
import { MESSAGE_INPUT_SUBMIT_EVENT } from '../../utils/message-input-events';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const toolResult = (props: Record<string, unknown>) =>
  JSON.stringify({
    __generative_ui_spec: true,
    spec: { root: 'r', elements: { r: { type: 'SuggestedReplies', props, children: [] } } },
  });

const OPTIONS = [
  { label: 'Tokyo', description: 'ap-northeast-1' },
  { label: 'Oregon', value: 'Deploy to us-west-2 please' },
  { label: 'Virginia' },
];

describe('SuggestedReplies', () => {
  const submitted: string[] = [];
  const focused = vi.fn();
  const onSubmit = (e: Event) => submitted.push((e as CustomEvent<{ text: string }>).detail.text);

  beforeEach(() => {
    submitted.length = 0;
    focused.mockReset();
    window.addEventListener(MESSAGE_INPUT_SUBMIT_EVENT, onSubmit);
    window.addEventListener('focusMessageInput', focused);
  });

  afterEach(() => {
    window.removeEventListener(MESSAGE_INPUT_SUBMIT_EVENT, onSubmit);
    window.removeEventListener('focusMessageInput', focused);
    cleanup();
  });

  it('sends the label (or value) of the clicked option and then locks', () => {
    render(
      <JsonRenderBlock
        content={toolResult({ question: 'Region?', options: OPTIONS })}
        interactive
      />
    );

    expect(screen.getByText('Region?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Oregon/ }));
    expect(submitted).toEqual(['Deploy to us-west-2 please']);

    fireEvent.click(screen.getByRole('radio', { name: /Tokyo/ }));
    expect(submitted).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Tokyo/ })).toBeDisabled();
  });

  it('does nothing when not interactive (older message or agent busy)', () => {
    render(<JsonRenderBlock content={toolResult({ options: OPTIONS })} />);

    const tokyo = screen.getByRole('radio', { name: /Tokyo/ });
    expect(tokyo).toBeDisabled();
    fireEvent.click(tokyo);
    expect(submitted).toEqual([]);
  });

  it('multiSelect sends selected options together in display order', () => {
    render(
      <JsonRenderBlock content={toolResult({ options: OPTIONS, multiSelect: true })} interactive />
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Virginia/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tokyo/ }));
    expect(submitted).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'generativeUi.suggestedReplies.send' }));
    expect(submitted).toEqual(['Tokyo\nVirginia']);
  });

  it('"Other" focuses the chat input instead of sending', () => {
    render(<JsonRenderBlock content={toolResult({ options: OPTIONS })} interactive />);

    fireEvent.click(screen.getByRole('button', { name: 'generativeUi.suggestedReplies.other' }));
    expect(focused).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual([]);
  });

  it('renders radios for single-select and checkboxes for multiSelect', () => {
    const { unmount } = render(
      <JsonRenderBlock content={toolResult({ options: OPTIONS })} interactive />
    );
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    unmount();

    render(
      <JsonRenderBlock content={toolResult({ options: OPTIONS, multiSelect: true })} interactive />
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Tokyo/ }));
    expect(screen.getByRole('checkbox', { name: /Tokyo/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('hides "Other" when allowOther=false', () => {
    render(
      <JsonRenderBlock content={toolResult({ options: OPTIONS, allowOther: false })} interactive />
    );
    expect(
      screen.queryByRole('button', { name: 'generativeUi.suggestedReplies.other' })
    ).not.toBeInTheDocument();
  });
});
