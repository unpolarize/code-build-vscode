import { useState } from 'react';
import type { AskUserQuestionEntry } from '../store';

interface Props {
  toolCallId: string;
  questions: AskUserQuestionEntry[];
  /** Null while the user hasn't answered yet; the record of their picks
   * once they have (keyed by question header or index). */
  answers: Record<string, string> | null;
  onAnswer: (toolCallId: string, answers: Record<string, string>) => void;
}

/** Sentinel used internally for the "Other (free text)" pseudo-option.
 * When the user picks this and types into the input, we send the typed
 * string back as the answer — matching Claude Code's IDE renderer
 * which always offers an Other / custom-text path. */
const OTHER = '__OTHER__';

/**
 * Render an agent's AskUserQuestion tool call as a stack of question cards
 * with clickable options. Each question contributes one entry to the
 * answer record, keyed by its header (or its index when no header was
 * given). Each card also exposes an "Other" option that reveals a text
 * input — without it, the user was stuck answering only with the
 * agent's predefined buttons even when none fit (matches Claude Code's
 * standard IDE behaviour). Once submitted, the card switches into a
 * read-only summary so the chosen text stays visible in the
 * conversation history.
 */
export function AskUserQuestionCard({ toolCallId, questions, answers, onAnswer }: Props) {
  const answered = answers != null;

  return (
    <div className="msg msg-askuser">
      <div className="msg-role">Agent · question{questions.length > 1 ? 's' : ''}</div>
      {answered ? (
        <SubmittedView questions={questions} answers={answers!} />
      ) : (
        <FormBody
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

/** Interactive picker — one radio-style option grid per question, plus
 * a free-text input revealed when the user picks the trailing "Other"
 * option. State is hoisted into a small reducer; the parent owns the
 * submit handler. */
function FormBody({
  questions,
  onSubmit
}: {
  questions: AskUserQuestionEntry[];
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  function setPick(qKey: string, value: string) {
    setPicks((prev) => ({ ...prev, [qKey]: value }));
  }
  function setOther(qKey: string, value: string) {
    setOtherText((prev) => ({ ...prev, [qKey]: value }));
  }

  const allAnswered = questions.every((q, i) => {
    const key = q.header ?? `q${i}`;
    const choice = picks[key];
    if (choice == null) return false;
    // "Other" is only complete when the typed text is non-empty.
    if (choice === OTHER) return (otherText[key] ?? '').trim().length > 0;
    return true;
  });

  function submit() {
    const resolved: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const key = q.header ?? `q${i}`;
      const choice = picks[key];
      resolved[key] = choice === OTHER ? otherText[key].trim() : choice;
    }
    onSubmit(resolved);
  }

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
              {/* "Other" pseudo-option — gives the user a free-text
                  escape hatch when none of the predefined options
                  apply. Mirrors Claude Code's IDE renderer. */}
              <button
                className={`askuser-option askuser-option-other${selected === OTHER ? ' askuser-option-selected' : ''}`}
                onClick={() => setPick(key, OTHER)}
              >
                <div className="askuser-option-label">Other (enter your answer)</div>
                <div className="askuser-option-desc">
                  Type a custom answer when none of the above fit.
                </div>
              </button>
            </div>
            {selected === OTHER && (
              <textarea
                className="askuser-other-input"
                placeholder="Type your answer…"
                value={otherText[key] ?? ''}
                onChange={(e) => setOther(key, e.target.value)}
                rows={3}
                autoFocus
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits early — same shortcut as
                  // the composer for muscle-memory consistency.
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && allAnswered) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            )}
          </div>
        );
      })}
      <div className="askuser-actions">
        <button className="btn btn-send" disabled={!allAnswered} onClick={submit}>
          Send answer{questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
