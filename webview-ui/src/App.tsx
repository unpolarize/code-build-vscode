import { useEffect, useReducer } from 'react';
import type { HostToWebview } from '../../src/shared/protocol';
import type { PermissionMode, PermissionOutcome } from '../../src/shared/acpTypes';
import { post } from './vscodeApi';
import { appendUser, initialState, reduce, type ChatState } from './store';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { PermissionPrompt } from './components/PermissionPrompt';

type Action =
  | { kind: 'host'; msg: HostToWebview }
  | { kind: 'sendUser'; text: string }
  | { kind: 'clearPermission' };

function appReducer(state: ChatState, action: Action): ChatState {
  if (action.kind === 'host') return reduce(state, action.msg);
  if (action.kind === 'sendUser') return appendUser(state, action.text);
  if (action.kind === 'clearPermission') return { ...state, permission: null };
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

  function onSend(text: string) {
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

  return (
    <div className="app">
      <Header
        state={state}
        onPickBackend={onPickBackend}
        onSetMode={onSetMode}
        onNewSession={() => post({ type: 'newSession' })}
      />
      <MessageList items={state.items} />
      {state.permission && (
        <PermissionPrompt permission={state.permission} onRespond={onRespond} />
      )}
      <Composer
        busy={state.busy}
        commands={state.commands}
        onSend={onSend}
        onCancel={() => post({ type: 'cancel' })}
      />
    </div>
  );
}
