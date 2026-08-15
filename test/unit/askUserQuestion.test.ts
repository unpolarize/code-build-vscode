import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAskUserQuestionAccepted,
  buildAskUserQuestionCancelled,
  isAskUserQuestionMethod,
  parseAskUserQuestionParams,
  unwrapExtParams
} from '../../src/host/transports/askUserQuestion';

describe('isAskUserQuestionMethod', () => {
  it('accepts both ACP ext-method names', () => {
    assert.equal(isAskUserQuestionMethod('x.ai/ask_user_question'), true);
    assert.equal(isAskUserQuestionMethod('_x.ai/ask_user_question'), true);
    assert.equal(isAskUserQuestionMethod('session/request_permission'), false);
  });
});

describe('unwrapExtParams', () => {
  it('unwraps the _x.ai envelope', () => {
    const inner = { sessionId: 's', toolCallId: 'tc', questions: [] };
    assert.deepEqual(
      unwrapExtParams({ method: 'x.ai/ask_user_question', params: inner }),
      inner
    );
  });

  it('passes through a direct payload', () => {
    const inner = { sessionId: 's', toolCallId: 'tc', questions: [] };
    assert.deepEqual(unwrapExtParams(inner), inner);
  });
});

describe('parseAskUserQuestionParams', () => {
  it('parses camelCase Grok payload', () => {
    const parsed = parseAskUserQuestionParams({
      sessionId: 'sess',
      toolCallId: 'tc-1',
      mode: 'plan',
      questions: [
        {
          question: 'Which layout?',
          multiSelect: false,
          options: [
            { label: 'Splitter + maximize', description: 'Drag handle', preview: 'a' }
          ]
        }
      ]
    });
    assert.ok(parsed);
    assert.equal(parsed!.toolCallId, 'tc-1');
    assert.equal(parsed!.mode, 'plan');
    assert.equal(parsed!.questions[0].question, 'Which layout?');
    assert.equal(parsed!.questions[0].options[0].label, 'Splitter + maximize');
  });

  it('parses snake_case + wrapped _x.ai envelope', () => {
    const parsed = parseAskUserQuestionParams({
      method: '_x.ai/ask_user_question',
      params: {
        session_id: 's',
        tool_call_id: 'tc-2',
        questions: [{ question: 'Go?', multi_select: true, options: [{ label: 'Yes' }] }]
      }
    });
    assert.ok(parsed);
    assert.equal(parsed!.toolCallId, 'tc-2');
    assert.equal(parsed!.questions[0].multiSelect, true);
  });

  it('returns null without a toolCallId', () => {
    assert.equal(parseAskUserQuestionParams({ questions: [] }), null);
  });
});

describe('buildAskUserQuestionAccepted', () => {
  it('maps question→label into Grok vec answers', () => {
    const resp = buildAskUserQuestionAccepted({ 'Which layout?': 'Splitter + maximize' });
    assert.equal(resp.outcome, 'accepted');
    assert.deepEqual(resp.answers['Which layout?'], ['Splitter + maximize']);
  });
});

describe('buildAskUserQuestionCancelled', () => {
  it('returns cancelled outcome', () => {
    assert.deepEqual(buildAskUserQuestionCancelled(), { outcome: 'cancelled' });
  });
});
