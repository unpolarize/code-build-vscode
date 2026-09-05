import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { HostToWebview } from '../../src/shared/protocol';
import type { PermissionMode, PermissionOutcome } from '../../src/shared/acpTypes';
import { post, setState } from './vscodeApi';
import { parseUriList } from './util/mentions';
import { appendUser, initialState, markAskUserAnswered, reduce, type ChatState, type ImageAttachment } from './store';
import { BUILTIN_COMMANDS, BUILTIN_NAMES, parseCompactFocus } from './builtinCommands';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { PermissionPrompt } from './components/PermissionPrompt';
import { MessageNav } from './components/MessageNav';
import { PrimerBanner } from './components/PrimerBanner';
import { FailoverBanner } from './components/FailoverBanner';
import { ResumePauseBanner } from './components/ResumePauseBanner';
import { ActiveQuestionBanner } from './components/ActiveQuestionBanner';
import type { BackendId } from '../../src/shared/acpTypes';
import { ActivityStrip } from './components/ActivityStrip';
import { NowLine } from './components/NowLine';
import { PerfPanel } from './components/PerfPanel';
import { VoiceBar } from './components/VoiceBar';
import { useVoiceController } from './voice/useVoiceController';
import {
  clampComposerHeight,
  COMPOSER_MIN_HEIGHT,
  loadComposerLayout,
  maximizedComposerHeight,
  saveComposerLayout
} from './util/composerLayout';

type Action =
  | { kind: 'host'; msg: HostToWebview }
  | { kind: 'sendUser'; text: string; images?: ImageAttachment[]; interjected?: boolean }
  | { kind: 'resolvePermission'; requestId: string }
  | { kind: 'clearPrimer' }
  | { kind: 'clearFailover' }
  | { kind: 'clearItems' }
  | { kind: 'askUserAnswered'; toolCallId: string; answers: Record<string, string> };

function appReducer(state: ChatState, action: Action): ChatState {
  if (action.kind === 'host') return reduce(state, action.msg);
  if (action.kind === 'sendUser')
    return appendUser(state, action.text, action.images, action.interjected);
  if (action.kind === 'resolvePermission')
    return {
      ...state,
      permissionQueue: state.permissionQueue.filter((p) => p.requestId !== action.requestId)
    };
  if (action.kind === 'clearPrimer') return { ...state, primerPrompt: null };
  if (action.kind === 'clearFailover') return { ...state, failoverOffer: null };
  if (action.kind === 'askUserAnswered')
    return markAskUserAnswered(state, action.toolCallId, action.answers);
  if (action.kind === 'clearItems')
    // Also drop queued permission prompts — the host disposes the old
    // session (cancelling their resolvers), so a kept modal would no-op.
    return {
      ...state,
      items: [],
      usage: null,
      usageBreakdown: [],
      permissionQueue: [],
      failoverOffer: null,
      resumePause: null
    };
  return state;
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [dragActive, setDragActive] = useState(false);
  const [composerSeed, setComposerSeed] = useState<string | undefined>(undefined);
  const [follow, setFollow] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const initialLayout = loadComposerLayout();
  const [composerHeight, setComposerHeight] = useState(initialLayout.height);
  const [composerMax, setComposerMax] = useState(initialLayout.maximized);
  const composerHeightRef = useRef(composerHeight);
  composerHeightRef.current = composerHeight;
  const appRef = useRef<HTMLDivElement>(null);
  const lastHostMsgAt = useRef(performance.now());
  const reduceMsBuf = useRef<number[]>([]);
  const prevBusy = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const sendText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    if (handleBuiltinRef.current?.(t)) return;
    const interjected = stateRef.current.busy === true;
    dispatch({ kind: 'sendUser', text: t, images: [], interjected });
    post({ type: 'prompt', blocks: [{ type: 'text', text: t }], interjected });
  }, []);

  const handleBuiltinRef = useRef<(text: string) => boolean>(() => false);

  const voice = useVoiceController({
    ttsEngine: state.voiceConfig.ttsEngine,
    lang: state.voiceConfig.lang,
    utteranceEndMs: state.voiceConfig.utteranceEndMs,
    ttsEnabled: state.voiceConfig.ttsEnabled,
    hostSpeaks: state.voiceConfig.hostSpeaks,
    sttEngine: state.voiceConfig.sttEngine,
    hostSttAvailable: state.voiceConfig.hostSttAvailable,
    onHostSpeak: (text) => post({ type: 'ttsSpeak', text }),
    onHostStopSpeak: () => post({ type: 'ttsStop' }),
    onHostSttStart: (lang) => post({ type: 'sttStart', lang }),
    onHostSttStop: () => post({ type: 'sttStop' }),
    onSend: sendText,
    onStartVis: () => {
      dispatch({ kind: 'clearItems' });
      post({ type: 'startVoiceIdeation' });
    },
    onEndVis: () => post({ type: 'endVoiceIdeation' }),
    onClosePhrase: () => post({ type: 'endVoiceIdeation' })
  });

  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // Report mode to host (status / future status bar).
  useEffect(() => {
    post({ type: 'voiceModeChanged', mode: voice.mode });
  }, [voice.mode]);

  // When agent finishes a turn in interactive/ideation, read reply aloud.
  useEffect(() => {
    const wasBusy = prevBusy.current;
    prevBusy.current = state.busy;
    voiceRef.current.onBusyChange(state.busy);
    if (wasBusy && !state.busy) {
      const items = stateRef.current.items;
      let last = '';
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === 'assistant' && it.text.trim()) {
          last = it.text;
          break;
        }
      }
      voiceRef.current.onTurnComplete(last);
    }
  }, [state.busy]);

  // Host TTS / STT / voice commands (stable listener).
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const m = e.data as HostToWebview;
      if (!m || typeof m !== 'object') return;
      const v = voiceRef.current;
      if (m.type === 'ttsDone') {
        v.onHostTtsDone();
      }
      if (m.type === 'sttResult') {
        v.onHostSttResult(m.transcript, m.isFinal);
      }
      if (m.type === 'sttStatus') {
        v.onHostSttStatus(m.status, m.detail);
      }
      if (m.type === 'voiceCommand') {
        switch (m.action) {
          case 'toggleDictation':
            v.toggleDictation();
            break;
          case 'toggleInteractive':
            v.toggleInteractive();
            break;
          case 'startVis':
            v.startIdeation();
            break;
          case 'endVis':
            post({ type: 'endVoiceIdeation' });
            v.stopAll();
            break;
          case 'stopVoice':
            v.stopAll();
            break;
        }
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Dictation → push partial into composer seed when listening
  useEffect(() => {
    if (voice.mode === 'dictation' && voice.partial) {
      setComposerSeed(voice.partial);
    }
  }, [voice.mode, voice.partial]);

  // App-level drop handler. The Composer used to handle drops itself,
  // but that left every other area of the panel (chat history, header,
  // banners) as a non-drop target — VS Code's default workbench
  // handler then opened the dragged file in an editor / new window
  // instead of producing an @-mention. Hoisting the handler to the
  // root `.app` div catches drops anywhere in the webview and routes
  // them through the existing `resolveDroppedUris` → host →
  // `droppedFilesResolved` round-trip the Composer's message listener
  // already handles. Reported in notes.md as the drag-from-Explorer
  // bug.
  function onAppDragOver(e: React.DragEvent) {
    // preventDefault is required for the drop event to actually fire.
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }
  function onAppDragLeave(e: React.DragEvent) {
    // Only flip off when the drag actually leaves the app root, not
    // when it crosses a child boundary (relatedTarget would be a
    // descendant). currentTarget.contains() filters those out.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }
  function onAppDrop(e: React.DragEvent) {
    const dt = e.dataTransfer;
    if (!dt) return;
    let uris = parseUriList(dt.getData('text/uri-list'));
    if (uris.length === 0) {
      // VS Code's Explorer also exposes drops via the
      // application/vnd.code.uri-list MIME type and the legacy
      // `resourceurls` JSON payload. Try both before giving up.
      const codeMime = dt.getData('application/vnd.code.uri-list');
      if (codeMime) {
        uris = parseUriList(codeMime);
      }
      if (uris.length === 0) {
        const ru = dt.getData('resourceurls');
        if (ru) {
          try {
            uris = (JSON.parse(ru) as string[]).map((u) => decodeURIComponent(u));
          } catch {
            /* not the format we expected — ignore */
          }
        }
      }
    }
    // OS image drags carry no workspace path but DO carry the file
    // object on dt.files. Forward to the Composer via a custom event
    // so the existing image-tile path keeps working from anywhere
    // in the panel.
    const files: File[] = [];
    if (dt.files) {
      for (let i = 0; i < dt.files.length; i++) {
        files.push(dt.files[i]);
      }
    }
    if (uris.length === 0 && files.length === 0) return; // let VS Code handle it
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (uris.length > 0) {
      post({ type: 'resolveDroppedUris', uris });
    }
    if (files.length > 0) {
      // Composer already has the FileReader → base64 logic wired
      // for its inline drop handler. Re-use it by emitting a
      // CustomEvent the Composer listens for. Keeps the
      // image-attachment state in one place.
      window.dispatchEvent(new CustomEvent('cb-app-drop-files', { detail: files }));
    }
  }

  useEffect(() => {
    setOlderLoading(false);
  }, [state.olderSeq, state.hasOlder]);

  /** Scroll-up and the ↑ navigator share one request path for older pages. */
  function requestOlder() {
    if (!state.hasOlder || olderLoading) return;
    setOlderLoading(true);
    post({ type: 'loadOlderHistory' });
  }

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const t0 = performance.now();
      lastHostMsgAt.current = t0;
      dispatch({ kind: 'host', msg: e.data as HostToWebview });
      const ms = performance.now() - t0;
      reduceMsBuf.current.push(ms);
      if (reduceMsBuf.current.length > 30) reduceMsBuf.current.shift();
    };
    window.addEventListener('message', handler);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // While busy, report paint lag + reduce cost to the host (perf debug).
  useEffect(() => {
    if (state.perfDebug === 'off') return;
    if (!state.busy) return;
    const id = window.setInterval(() => {
      const samples = reduceMsBuf.current;
      const renderMs =
        samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const paintLagMs = Math.max(0, performance.now() - lastHostMsgAt.current);
      post({
        type: 'perfSample',
        samples: [
          {
            t: Date.now(),
            renderMs,
            items: state.items.length,
            paintLagMs
          }
        ]
      });
    }, 500);
    return () => clearInterval(id);
  }, [state.busy, state.perfDebug, state.items.length]);

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

  // Merge always-on built-ins with agent-provided commands for the slash
  // palette. Agent commands that collide with a builtin name (e.g. grok's
  // /compact) are dropped — handleBuiltin intercepts them anyway, so listing
  // both would show a duplicate entry that can never reach the agent.
  const allCommands = [
    ...BUILTIN_COMMANDS,
    ...state.commands.filter((c) => !BUILTIN_NAMES.has(c.name))
  ];

  /** Intercept built-in slash commands; everything else (incl. agent commands) is sent. */
  function handleBuiltin(text: string): boolean {
    const m = /^\/([\w-]+)\b/.exec(text.trim());
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
      case 'perf':
        post({ type: 'togglePerfPanel' });
        post({ type: 'requestPerfSnapshot' });
        break;
      case 'handoff':
        post({ type: 'handoff' });
        break;
      case 'kp':
        // Host-side picker — never forwarded to the agent as prompt text.
        post({ type: 'kpPick' });
        break;
      case 'compact':
        // Built-in shadows any agent-advertised /compact (BUILTIN_NAMES
        // wins here); the host does the summarize→respawn, never the agent.
        post({ type: 'compact', focus: parseCompactFocus(text) });
        break;
      case 'voice':
        voice.toggleInteractive();
        break;
      case 'dictation':
        voice.toggleDictation();
        break;
      case 'vis':
        voice.startIdeation();
        break;
      case 'vis-close':
        post({ type: 'endVoiceIdeation' });
        voice.stopAll();
        break;
      case 'stop-voice':
        voice.stopAll();
        break;
    }
    return true;
  }
  handleBuiltinRef.current = handleBuiltin;

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
    setFollow(true);
  }

  function panelHeight(): number {
    return appRef.current?.clientHeight ?? window.innerHeight;
  }

  function persistComposer(height: number, maximized: boolean) {
    saveComposerLayout({ height, maximized });
  }

  function onSplitterDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = composerHeightRef.current;
    const maxH = panelHeight();
    function move(ev: MouseEvent) {
      const next = clampComposerHeight(startH + (startY - ev.clientY), maxH);
      setComposerHeight(next);
      setComposerMax(false);
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      persistComposer(composerHeightRef.current, false);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function toggleComposerMax() {
    const ph = panelHeight();
    if (composerMax) {
      setComposerMax(false);
      persistComposer(composerHeight, false);
    } else {
      const next = maximizedComposerHeight(ph);
      setComposerHeight(next);
      setComposerMax(true);
      persistComposer(next, true);
    }
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
    dispatch({ kind: 'resolvePermission', requestId });
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
    <div
      ref={appRef}
      className={`app${dragActive ? ' app-drop-active' : ''}`}
      onDragOver={onAppDragOver}
      onDragLeave={onAppDragLeave}
      onDrop={onAppDrop}
    >
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
        onTogglePerf={() => {
          post({ type: 'togglePerfPanel' });
          post({ type: 'requestPerfSnapshot' });
        }}
        onSetStallTimeout={(seconds) => post({ type: 'setStallTimeout', seconds })}
      />
      <ActivityStrip
        segments={state.activitySegments}
        turnDurationMs={state.activityTurnDurationMs}
        visible={state.perfDebug !== 'off' && state.busy}
      />
      <PerfPanel
        open={state.perfPanelOpen}
        snapshot={state.perfSnapshot}
        onClose={() => post({ type: 'togglePerfPanel' })}
        onRefresh={() => post({ type: 'requestPerfSnapshot' })}
        onCopy={() => post({ type: 'copyPerfReport' })}
        onExport={() => post({ type: 'exportPerf' })}
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
      {state.failoverOffer && (
        <FailoverBanner
          offer={{
            errorClass: state.failoverOffer.errorClass,
            fromBackend: state.failoverOffer.fromBackend as BackendId,
            fromLabel: state.failoverOffer.fromLabel,
            suggestedBackend: state.failoverOffer.suggestedBackend as BackendId,
            suggestedLabel: state.failoverOffer.suggestedLabel,
            alternatives: state.failoverOffer.alternatives.map((a) => ({
              id: a.id as BackendId,
              label: a.label
            })),
            message: state.failoverOffer.message
          }}
          onDecide={(accept, backend) => {
            post({ type: 'failoverDecision', accept, backend });
            dispatch({ kind: 'clearFailover' });
          }}
        />
      )}
      {state.resumePause && (
        <ResumePauseBanner
          label={state.resumePause.label}
          resumeAt={state.resumePause.resumeAt}
          onAction={(action) => post({ type: 'resumePauseAction', action })}
        />
      )}
      <HistoryLoadBar load={state.historyLoad} />
      <MessageList
        items={state.items}
        busy={state.busy}
        loading={state.historyLoad?.phase === 'loading'}
        follow={follow}
        onFollowChange={setFollow}
        checkpointIds={state.checkpointIds}
        hasOlder={state.hasOlder}
        olderSeq={state.olderSeq}
        olderLoading={olderLoading}
        onNeedOlder={requestOlder}
        onAskUserAnswer={(toolCallId, answers) => {
          dispatch({ kind: 'askUserAnswered', toolCallId, answers });
          post({ type: 'askUserAnswer', toolCallId, answers });
        }}
      />
      <MessageNav
        items={state.items}
        follow={follow}
        onNavigate={(_idx, isLast) => {
          // Arrows pin a prompt; they must not resume follow-the-tail even
          // on the last turn (a long last reply sits well above the tail).
          // Only Send and **latest** pin to the live end.
          if (!isLast) setFollow(false);
        }}
        onJumpLatest={() => setFollow(true)}
        hasOlder={state.hasOlder}
        onNeedOlder={requestOlder}
      />
      {state.permissionQueue.length > 0 && (
        <PermissionPrompt
          permission={state.permissionQueue[0]}
          queued={state.permissionQueue.length - 1}
          onRespond={onRespond}
        />
      )}
      <VoiceBar
        voice={voice}
        voiceEnabled={state.voiceEnabled}
        visActive={state.visActive}
        onEndVis={() => post({ type: 'endVoiceIdeation' })}
      />
      <NowLine now={state.nowLine} />
      <div
        className="composer-shell"
        style={{
          height: composerMax
            ? maximizedComposerHeight(panelHeight())
            : Math.max(COMPOSER_MIN_HEIGHT, composerHeight)
        }}
      >
        <div
          className="composer-split"
          onMouseDown={onSplitterDown}
          title="Drag to resize the input"
          role="separator"
          aria-orientation="horizontal"
        />
        <Composer
          busy={state.busy}
          commands={allCommands}
          fileSuggestions={state.fileSuggestions}
          onSend={onSend}
          onCancel={() => post({ type: 'cancel' })}
          onRequestFileSuggestions={onRequestFileSuggestions}
          seedText={composerSeed}
          onSeedConsumed={() => setComposerSeed(undefined)}
          listening={voice.listening && voice.mode === 'dictation'}
          onToggleDictation={() => voice.toggleDictation()}
          model={state.session?.model}
          maximized={composerMax}
          onToggleMaximize={toggleComposerMax}
        />
      </div>
    </div>
  );
}

function HistoryLoadBar({ load }: { load: ChatState['historyLoad'] }) {
  if (!load || load.phase === 'done') return null;
  const pct = load.bytesTotal > 0 ? Math.min(100, (100 * load.bytesRead) / load.bytesTotal) : 0;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1);
  const label =
    load.phase === 'error'
      ? `Could not load history: ${load.error || 'unknown error'}`
      : `Loading conversation… ${mb(load.bytesRead)} / ${mb(load.bytesTotal)} MB · ${load.records.toLocaleString()} events`;
  return (
    <div className={`history-load${load.phase === 'error' ? ' history-load-error' : ''}`} role="status">
      {load.phase === 'loading' && (
        <div className="history-load-track">
          <div className="history-load-bar" style={{ width: `${pct}%` }} />
        </div>
      )}
      <span>{label}</span>
    </div>
  );
}
