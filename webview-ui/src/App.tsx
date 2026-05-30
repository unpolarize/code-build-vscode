import { useEffect, useReducer } from 'react';
import type { HostToWebview } from '../../src/shared/protocol';
import type { PermissionMode, PermissionOutcome } from '../../src/shared/acpTypes';
import { post } from './vscodeApi';
import { appendUser, initialState, reduce, type ChatState } from './store';
import { BUILTIN_COMMANDS, BUILTIN_NAMES } from './builtinCommands';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { PermissionPrompt } from './components/PermissionPrompt';

type Action =
  | { kind: 'host'; msg: HostToWebview }
  | { kind: 'sendUser'; text: string }
  | { kind: 'clearPermission' }
  | { kind: 'clearItems' };

function appReducer(state: ChatState, action: Action): ChatState {
  if (action.kind === 'host') return reduce(state, action.msg);
  if (action.kind === 'sendUser') return appendUser(state, action.text);
  if (action.kind === 'clearPermission') return { ...state, permission: null };
  if (action.kind === 'clearItems') return { ...state, items: [], usage: null };
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

  function onSend(text: string) {
    if (handleBuiltin(text)) return;
    dispatch({ kind: 'sendUser', text });
    post({ type: 'prompt', blocks: [{ type: 'text', text }] });
  }

  function onPickBackend(id: string) {
    if (id) post({ type: 'pickBackend', backend: id as never });
  }

  function onSetMode(mode: PermissionMode) {
    post({ type: 'setMode', mode });
  }

  function onRespond(requestId: string, outcome: PermissionOutcome) {
    post({ type: 'respondPermission', requestId, outcome });
    dispatch({ kind: 'clearPermission' });
  }

  function onRequestFileSuggestions(query: string) {
    post({ type: 'getFileSuggestions', query });
  }

  function onResumeSession(id: string) {
    dispatch({ kind: 'clearItems' });
    post({ type: 'resumeSession', id });
  }

  return (
    <div className="app">
      <Header
        state={state}
        onPickBackend={onPickBackend}
        onSetMode={onSetMode}
        onNewSession={() => post({ type: 'newSession' })}
        onOpenInNewTab={() => post({ type: 'openInNewTab' })}
        onOpenInNewWindow={() => post({ type: 'openInNewWindow' })}
        onResumeSession={onResumeSession}
        onRefreshSessions={() => post({ type: 'listSessions' })}
      />
      <MessageList items={state.items} />
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
