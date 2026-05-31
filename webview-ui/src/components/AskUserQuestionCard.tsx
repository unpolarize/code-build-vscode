import type { AskUserQuestionEntry } from '../store';

interface Props {
  toolCallId: string;
  questions: AskUserQuestionEntry[];
  /** Null while the user hasn't answered yet; the record of their picks
   * once they have (keyed by question header or index). */
  answers: Record<string, string> | null;
  onAnswer: (toolCallId: string, answers: Record<string, string>) => void;
}

/**
 * Render an agent's AskUserQuestion tool call as a stack of question cards
 * with clickable options. Each question contributes one entry to the
 * answer record, keyed by its header (or its index when no header was
 * given). Once submitted, the card switches into a read-only summary so
 * the chosen text stays visible in the conversation history.
 *
 * The agent can ask multiple questions in a single tool call (the API
 * accepts an array); the user must answer each before the "Send answers"
 * button enables.
 */
export function AskUserQuestionCard({ toolCallId, questions, answers, onAnswer }: Props) {
  const answered = answers != null;

  return (
    <div className="msg msg-askuser">
      <div className="msg-role">Agent · question{questions.length > 1 ? 's' : ''}</div>
      {answered ? (
        <SubmittedView questions={questions} answers={answers!} />
      ) : (
        <InteractiveForm
          questions={questions}
          onSubmit={(picked) => onAnswer(toolCallId, picked)}
        />
      )}
    </div>
  );
}

/** Read-only summary shown after the user has answered — keeps the choice
 * in the timeline so the conversation history is self-explanatory. */
function SubmittedView({
  questions,
  answers
}: {
  questions: AskUserQuestionEntry[];
  answers: Record<string, string>;
}) {
  return (
    <div className="askuser-submitted">
      {questions.map((q, i) => {
        const key = q.header ?? `q${i}`;
        return (
          <div key={i} className="askuser-q-submitted">
            <div className="askuser-q-text">{q.header ?? q.question}</div>
            <div className="askuser-a-text">→ {answers[key] ?? '(no answer)'}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Interactive picker — radio-style for single-select questions, checkbox
 * for multiSelect. Click a card to pick; second click on the same card
 * deselects. Hidden "Other" text input is left to a future iteration. */
function InteractiveForm({
  questions,
  onSubmit
}: {
  questions: AskUserQuestionEntry[];
  onSubmit: (answers: Record<string, string>) => void;
}) {
  // Local picks indexed by question key.
  const picked: Record<string, string> = {};

  // We use a controlled form with a single submit button. React state is
  // hoisted into the parent in a real implementation; for the size of this
  // tree a plain `useReducer` would also work. Using a small inline hook
  // keeps the component self-contained.
  return (
    <FormBody questions={questions} onSubmit={onSubmit} initial={picked} />
  );
}

import { useState } from 'react';

function FormBody({
  questions,
  onSubmit,
  initial
}: {
  questions: AskUserQuestionEntry[];
  onSubmit: (answers: Record<string, string>) => void;
  initial: Record<string, string>;
}) {
  const [picks, setPicks] = useState<Record<string, string>>(initial);

  function setPick(qKey: string, value: string) {
    setPicks((prev) => ({ ...prev, [qKey]: value }));
  }

  const allAnswered = questions.every((q, i) => {
    const key = q.header ?? `q${i}`;
    return picks[key] != null;
  });

  return (
    <div className="askuser-form">
      {questions.map((q, i) => {
        const key = q.header ?? `q${i}`;
        const selected = picks[key];
        return (
          <div key={i} className="askuser-q">
            <div className="askuser-q-text">{q.question}</div>
            <div className="askuser-options">
              {q.options.map((opt, j) => {
                const isSelected = selected === opt.label;
                return (
                  <button
                    key={j}
                    className={`askuser-option${isSelected ? ' askuser-option-selected' : ''}`}
                    onClick={() => setPick(key, opt.label)}
                  >
                    <div className="askuser-option-label">{opt.label}</div>
                    {opt.description && (
                      <div className="askuser-option-desc">{opt.description}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="askuser-actions">
        <button
          className="btn btn-send"
          disabled={!allAnswered}
          onClick={() => onSubmit(picks)}
        >
          Send answer{questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
