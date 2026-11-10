// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { JsonRenderBlock } from '../JsonRenderBlock';
import { MESSAGE_INPUT_SUBMIT_EVENT } from '../../utils/message-input-events';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const QUESTIONS = [
  {
    header: 'Style',
    question: 'What kind of trip?',
    options: [{ label: 'Hot spring' }, { label: 'City', value: 'A city trip' }],
  },
  {
    header: 'Food',
    question: 'What do you want to eat?',
    multiSelect: true,
    options: [{ label: 'Sushi' }, { label: 'Ramen' }, { label: 'Curry' }],
  },
];

const toolResult = (props: Record<string, unknown>) =>
  JSON.stringify({
    __generative_ui_spec: true,
    spec: { root: 'r', elements: { r: { type: 'Questionnaire', props, children: [] } } },
  });

const next = () => screen.getByRole('button', { name: /generativeUi.questionnaire.next/ });
const toReview = () => screen.getByRole('button', { name: /generativeUi.questionnaire.toReview/ });
const submit = () => screen.getByRole('button', { name: /generativeUi.questionnaire.submit/ });

describe('Questionnaire', () => {
  const submitted: string[] = [];
  // Plays MessageInput: record the text and accept it (unless told to refuse).
  let refuse = false;
  const onSubmit = (e: Event) => {
    if (refuse) return;
    submitted.push((e as CustomEvent<{ text: string }>).detail.text);
    e.preventDefault();
  };

  beforeEach(() => {
    submitted.length = 0;
    refuse = false;
    window.addEventListener(MESSAGE_INPUT_SUBMIT_EVENT, onSubmit);
  });

  afterEach(() => {
    window.removeEventListener(MESSAGE_INPUT_SUBMIT_EVENT, onSubmit);
    cleanup();
  });

  it('pages through questions and sends all answers as one message', () => {
    render(<JsonRenderBlock content={toolResult({ questions: QUESTIONS })} interactive />);

    // Page 1: single choice (radio) auto-advances
    expect(screen.getByText('What kind of trip?')).toBeInTheDocument();
    expect(screen.queryByText('What do you want to eat?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /City/ }));

    // Page 2: multi choice (checkbox) needs an answer before moving on
    expect(screen.getByText('What do you want to eat?')).toBeInTheDocument();
    expect(toReview()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Curry/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Sushi/ }));
    fireEvent.click(toReview());

    // Review page, nothing sent yet
    expect(submitted).toEqual([]);
    fireEvent.click(submit());
    expect(submitted).toEqual([
      'Q. What kind of trip?\n- A city trip\n\nQ. What do you want to eat?\n- Sushi\n- Curry',
    ]);
    expect(screen.getByText('generativeUi.questionnaire.sent')).toBeInTheDocument();
  });

  it('"Other" takes an inline free-form answer', () => {
    render(<JsonRenderBlock content={toolResult({ questions: QUESTIONS })} interactive />);

    fireEvent.click(screen.getByRole('radio', { name: 'generativeUi.suggestedReplies.other' }));
    // Does not auto-advance until text is typed
    expect(next()).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Camping' } });
    fireEvent.click(next());
    fireEvent.click(screen.getByRole('checkbox', { name: /Ramen/ }));
    fireEvent.click(toReview());
    fireEvent.click(submit());

    expect(submitted[0]).toContain('Q. What kind of trip?\n- Camping');
  });

  it('keeps every checkbox when several are clicked before a re-render', () => {
    render(<JsonRenderBlock content={toolResult({ questions: QUESTIONS })} interactive />);

    fireEvent.click(screen.getByRole('radio', { name: /City/ }));
    const sushi = screen.getByRole('checkbox', { name: /Sushi/ });
    const ramen = screen.getByRole('checkbox', { name: /Ramen/ });
    act(() => {
      sushi.click();
      ramen.click();
    });
    fireEvent.click(toReview());
    fireEvent.click(submit());

    expect(submitted[0]).toContain('- Sushi\n- Ramen');
  });

  it('can go back and change an earlier answer', () => {
    render(<JsonRenderBlock content={toolResult({ questions: QUESTIONS })} interactive />);

    fireEvent.click(screen.getByRole('radio', { name: /Hot spring/ }));
    fireEvent.click(screen.getByRole('button', { name: /generativeUi.questionnaire.back/ }));
    expect(screen.getByRole('radio', { name: /Hot spring/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('radio', { name: /City/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Ramen/ }));
    fireEvent.click(toReview());
    fireEvent.click(submit());

    expect(submitted[0]).toContain('- A city trip');
    expect(submitted[0]).not.toContain('Hot spring');
  });

  it('keeps the answers editable when MessageInput refuses the send', () => {
    render(<JsonRenderBlock content={toolResult({ questions: QUESTIONS })} interactive />);

    fireEvent.click(screen.getByRole('radio', { name: /City/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Sushi/ }));
    fireEvent.click(toReview());
    refuse = true;
    fireEvent.click(submit());
    expect(screen.queryByText('generativeUi.questionnaire.sent')).not.toBeInTheDocument();

    refuse = false;
    fireEvent.click(submit());
    expect(submitted).toHaveLength(1);
  });

  it('skips questions without options instead of crashing', () => {
    render(
      <JsonRenderBlock
        content={toolResult({ questions: [{ question: 'Broken?' }, QUESTIONS[0]] })}
        interactive
      />
    );
    expect(screen.queryByText('Broken?')).not.toBeInTheDocument();
    expect(screen.getByText('What kind of trip?')).toBeInTheDocument();
  });

  it('is read-only (but browsable) when not interactive, without a review step', () => {
    render(<JsonRenderBlock content={toolResult({ questions: QUESTIONS })} />);

    expect(
      screen.queryByRole('button', { name: 'generativeUi.questionnaire.review' })
    ).not.toBeInTheDocument();

    expect(screen.getByRole('radio', { name: /City/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    expect(screen.getByText('What do you want to eat?')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Sushi/ })).toBeDisabled();
    // Last page of a history view: nowhere further to go
    expect(
      screen.queryByRole('button', { name: /generativeUi.questionnaire.toReview/ })
    ).not.toBeInTheDocument();
    expect(submitted).toEqual([]);
  });
});
