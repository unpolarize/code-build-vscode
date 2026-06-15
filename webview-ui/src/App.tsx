import { useEffect, useReducer } from 'react';
import type { HostToWebview } from '../../src/shared/protocol';
import type { PermissionMode, PermissionOutcome } from '../../src/shared/acpTypes';
import { post, setState } from './vscodeApi';
import { appendUser, initialState, markAskUserAnswered, reduce, type ChatState, type ImageAttachment } from './store';
import { BUILTIN_COMMANDS, BUILTIN_NAMES } from './builtinCommands';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { PermissionPrompt } from './components/PermissionPrompt';
import { MessageNav } from './components/MessageNav';
import { PrimerBanner } from './components/PrimerBanner';
import { ActiveQuestionBanner } from './components/ActiveQuestionBanner';

type Action =
  | { kind: 'host'; msg: HostToWebview }
  | { kind: 'sendUser'; text: string; images?: ImageAttachment[]; interjected?: boolean }
  | { kind: 'clearPermission' }
  | { kind: 'clearPrimer' }
  | { kind: 'clearItems' }
  | { kind: 'askUserAnswered'; toolCallId: string; answers: Record<string, string> };

function appReducer(state: ChatState, action: Action): ChatState {
  if (action.kind === 'host') return reduce(state, action.msg);
  if (action.kind === 'sendUser')
    return appendUser(state, action.text, action.images, action.interjected);
  if (action.kind === 'clearPermission') return { ...state, permission: null };
  if (action.kind === 'clearPrimer') return { ...state, primerPrompt: null };
  if (action.kind === 'askUserAnswered')
    return markAskUserAnswered(state, action.toolCallId, action.answers);
  if (action.kind === 'clearItems') return { ...state, items: [], usage: null, usageBreakdown: [] };
  return state;
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      dispatch({ kind: 'host', msg: e.data as HostToWebview });
    };
    window.addEventListener('message', handler);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Persist the active session id to webview state. VS Code returns this
  // blob to the panel serializer on the next deserialize, so a reload /
  // window-move resumes the same conversation instead of opening a fresh
  // chat. We only stash the id (not the whole transcript) — the host's
  // SessionStore already has the records, and the host re-replays them
  // through `historyLoaded` once `queueResume(id)` fires on the new
  // SessionManager.
  useEffect(() => {
    if (state.session?.id) {
      setState({ lastSessionId: state.session.id });
    }
  }, [state.session?.id]);

  // Merge always-on built-ins with agent-provided commands for the slash palette.
  const allCommands = [...BUILTIN_COMMANDS, ...state.commands];

  /** Intercept built-in slash commands; everything else (incl. agent commands) is sent. */
  function handleBuiltin(text: string): boolean {
    const m = /^\/(\w+)\b/.exec(text.trim());
    if (!m || !BUILTIN_NAMES.has(m[1])) return false;
    switch (m[1]) {
      case 'new':
        post({ type: 'newSession' });
        dispatch({ kind: 'clearItems' });
        break;
      case 'clear':
        dispatch({ kind: 'clearItems' });
        break;
      case 'history':
        post({ type: 'listSessions' });
        break;
      case 'tab':
        post({ type: 'openInNewTab' });
        break;
      case 'window':
        post({ type: 'openInNewWindow' });
        break;
    }
    return true;
  }

  function onSend(text: string, images: ImageAttachment[] = []) {
    if (!text && images.length === 0) return;
    if (text && handleBuiltin(text)) return;
    // A send while `busy === true` is a mid-stream steer: the user intervened
    // before the agent finished its previous turn. The host posts the prompt
    // to the live transport immediately — claude reads it as another `user`
    // line on stdin (queued by the CLI), grok queues at the ACP layer.
    const interjected = state.busy === true;
    dispatch({ kind: 'sendUser', text, images, interjected });
    // Compose the ACP-shaped block list: optional text leading, then one
    // `image` block per pasted attachment. Send-only image messages also
    // work — agents that accept multi-modal input get exactly this shape
    // (claude `image` content block, grok ACP `image` content block).
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; mimeType: string; data: string }
    > = [];
    if (text) blocks.push({ type: 'text', text });
    for (const img of images) blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    post({ type: 'prompt', blocks, interjected });
  }

  function onPickBackend(id: string) {
    if (id) post({ type: 'pickBackend', backend: id as never });
  }

  function onSetMode(mode: PermissionMode) {
    post({ type: 'setMode', mode });
  }

  function onSetModel(model: string) {
    post({ type: 'setModel', model });
  }

  function onSetEffort(effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
    post({ type: 'setEffort', effort });
  }

  function onRespond(requestId: string, outcome: PermissionOutcome) {
    post({ type: 'respondPermission', requestId, outcome });
    dispatch({ kind: 'clearPermission' });
  }

  function onRequestFileSuggestions(query: string) {
    post({ type: 'getFileSuggestions', query });
  }

  function onResumeSession(id: string, source?: 'codebuild' | 'claude' | 'grok', cwd?: string) {
    dispatch({ kind: 'clearItems' });
    // Forward source + cwd when the picked row is an upstream session — the
    // host needs both to locate the transcript and spawn the right backend.
    if (source && source !== 'codebuild' && cwd) {
      post({ type: 'resumeSession', id, source, cwd });
    } else {
      post({ type: 'resumeSession', id });
    }
  }

  return (
    <div className="app">
      <Header
        state={state}
        onPickBackend={onPickBackend}
        onSetMode={onSetMode}
        onSetModel={onSetModel}
        onSetEffort={onSetEffort}
        onNewSession={() => post({ type: 'newSession' })}
        onOpenInNewTab={() => post({ type: 'openInNewTab' })}
        onOpenInNewWindow={() => post({ type: 'openInNewWindow' })}
        onResumeSession={onResumeSession}
        onRefreshSessions={() => post({ type: 'listSessions' })}
      />
      {(() => {
        // Find the most recent user item to surface in the banner.
        // Walks backwards through items because chat order is
        // chronological. busy=true on the SessionManager side
        // implies the agent is still working on this user message.
        let lastUser: Extract<typeof state.items[number], { kind: 'user' }> | null = null;
        for (let i = state.items.length - 1; i >= 0; i--) {
          const it = state.items[i];
          if (it.kind === 'user') {
            lastUser = it;
            break;
          }
        }
        return (
          <ActiveQuestionBanner
            question={lastUser}
            busy={state.busy === true}
            visible={state.showActiveQuestionBanner}
          />
        );
      })()}
      {state.primerPrompt && (
        <PrimerBanner
          fromBackend={state.primerPrompt.fromBackend}
          toBackend={state.primerPrompt.toBackend}
          turnCount={state.primerPrompt.turnCount}
          llmSummarySupported={state.primerPrompt.llmSummarySupported}
          onDecide={(choice, lastNTurns) => {
            post({ type: 'primerDecision', choice, lastNTurns });
            dispatch({ kind: 'clearPrimer' });
          }}
        />
      )}
      <MessageList
        items={state.items}
        busy={state.busy}
        onAskUserAnswer={(toolCallId, answers) => {
          dispatch({ kind: 'askUserAnswered', toolCallId, answers });
          post({ type: 'askUserAnswer', toolCallId, answers });
        }}
      />
      <MessageNav items={state.items} />
      {state.permission && (
        <PermissionPrompt permission={state.permission} onRespond={onRespond} />
      )}
      <Composer
        busy={state.busy}
        commands={allCommands}
        fileSuggestions={state.fileSuggestions}
        onSend={onSend}
        onCancel={() => post({ type: 'cancel' })}
        onRequestFileSuggestions={onRequestFileSuggestions}
      />
    </div>
  );
}
