// React hook: voice mode state machine for CB (dictation / interactive / VIS).
// STT prefers host-side (macOS Speech via extension host) when hydrate says so;
// falls back to webview Web Speech with getUserMedia preflight + honest errors.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceMode } from '../../../src/shared/voiceIdeation';
import { isVisClosePhrase, textForSpeech } from '../../../src/shared/voiceIdeation';
import {
  isSttSupported,
  isTtsSupported,
  speakWeb,
  stopWebSpeech,
  SttSession,
  WEBVIEW_STT_UNSUPPORTED_MSG,
  type SttStatus
} from './speech';

export interface VoiceControllerConfig {
  /** TTS engine preference from hydrate. */
  ttsEngine: 'webview' | 'system' | 'auto' | 'off';
  lang: string;
  /** Silence / end-of-utterance debounce before auto-send (ms). */
  utteranceEndMs: number;
  /** When true, speak assistant replies. */
  ttsEnabled: boolean;
  /** Host will speak when ttsEngine resolves to system. */
  hostSpeaks: boolean;
  /**
   * Resolved STT engine from hydrate.
   * host = post sttStart/sttStop; webview = Web Speech; off = refuse.
   */
  sttEngine: 'host' | 'webview' | 'off';
  hostSttAvailable: boolean;
  onHostSpeak: (text: string) => void;
  onHostStopSpeak: () => void;
  onHostSttStart: (lang: string) => void;
  onHostSttStop: () => void;
  /** Send a user prompt (may be mid-stream steer). */
  onSend: (text: string) => void;
  /** Start / end VIS via host. */
  onStartVis: () => void;
  onEndVis: () => void;
  /** Called when a close phrase is detected in ideation mode. */
  onClosePhrase?: () => void;
}

export interface VoiceControllerState {
  mode: VoiceMode;
  sttStatus: SttStatus;
  listening: boolean;
  speaking: boolean;
  interim: string;
  partial: string;
  supported: boolean;
  ttsSupported: boolean;
  /** Which STT path is active for this session. */
  sttEngine: 'host' | 'webview' | 'off';
  error?: string;
}

export interface VoiceControllerApi extends VoiceControllerState {
  setMode: (mode: VoiceMode) => void;
  toggleDictation: () => void;
  toggleInteractive: () => void;
  startIdeation: () => void;
  stopAll: () => void;
  /** Inject final transcript into composer path without auto-send (dictation). */
  flushPartial: () => string;
  /** Agent turn ended — speak last assistant text if voice mode wants TTS. */
  onTurnComplete: (assistantText: string) => void;
  /** Agent became busy — pause listening during tool storms (optional). */
  onBusyChange: (busy: boolean) => void;
  /** Pause STT while host/system TTS is speaking (barge-in off by default). */
  onHostTtsDone: () => void;
  /** Host STT result event. */
  onHostSttResult: (transcript: string, isFinal: boolean) => void;
  /** Host STT status event. */
  onHostSttStatus: (status: SttStatus, detail?: string) => void;
}

export function useVoiceController(cfg: VoiceControllerConfig): VoiceControllerApi {
  const [mode, setModeState] = useState<VoiceMode>('off');
  const [sttStatus, setSttStatus] = useState<SttStatus>('idle');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState('');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | undefined>();

  const modeRef = useRef(mode);
  const partialRef = useRef('');
  const interimRef = useRef('');
  /** Last final host transcript + timestamp (dedupe only consecutive identical finals). */
  const lastHostFinalRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const busyRef = useRef(false);
  const speakingRef = useRef(false);
  const sttRef = useRef<SttSession | null>(null);
  const debounceRef = useRef<number | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const clearDebounce = () => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  const stopStt = useCallback(() => {
    clearDebounce();
    sttRef.current?.stop();
    sttRef.current = null;
    cfgRef.current.onHostSttStop();
    lastHostFinalRef.current = { text: '', at: 0 };
    setListening(false);
    setSttStatus('idle');
    setInterim('');
    interimRef.current = '';
  }, []);

  const stopTts = useCallback(() => {
    stopWebSpeech();
    cfgRef.current.onHostStopSpeak();
    setSpeaking(false);
    speakingRef.current = false;
  }, []);

  const stopAll = useCallback(() => {
    stopStt();
    stopTts();
    setModeState('off');
    modeRef.current = 'off';
    setPartial('');
    partialRef.current = '';
    setError(undefined);
  }, [stopStt, stopTts]);

  const speakReply = useCallback(
    (raw: string) => {
      const c = cfgRef.current;
      if (!c.ttsEnabled || c.ttsEngine === 'off') return;
      const clean = textForSpeech(raw);
      if (!clean) return;

      // Pause listening while speaking to avoid self-echo.
      const wasListening = modeRef.current === 'interactive' || modeRef.current === 'ideation';
      if (wasListening) {
        sttRef.current?.stop();
        cfgRef.current.onHostSttStop();
        setListening(false);
      }

      setSpeaking(true);
      speakingRef.current = true;

      const resumeListen = () => {
        setSpeaking(false);
        speakingRef.current = false;
        if (
          (modeRef.current === 'interactive' || modeRef.current === 'ideation') &&
          !busyRef.current
        ) {
          startListeningInternal();
        }
      };

      if (c.hostSpeaks) {
        c.onHostSpeak(clean);
        // Host signals done via onHostTtsDone
        return;
      }
      if (!isTtsSupported()) {
        setSpeaking(false);
        speakingRef.current = false;
        return;
      }
      speakWeb(clean, {
        lang: c.lang,
        onEnd: resumeListen,
        onError: (msg) => {
          setError(msg);
          resumeListen();
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const commitUtterance = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    const m = modeRef.current;
    if (m === 'ideation' && isVisClosePhrase(t)) {
      cfgRef.current.onClosePhrase?.();
      cfgRef.current.onEndVis();
      setPartial('');
      partialRef.current = '';
      setInterim('');
      interimRef.current = '';
      return;
    }
    if (m === 'dictation') {
      // Accumulate into partial; user hits send (or we leave in composer via partial)
      const next = (partialRef.current + ' ' + t).trim();
      partialRef.current = next;
      setPartial(next);
      return;
    }
    // interactive / ideation — auto-send
    cfgRef.current.onSend(t);
    setPartial('');
    partialRef.current = '';
    setInterim('');
    interimRef.current = '';
  }, []);

  const onFinalTranscript = useCallback(
    (piece: string) => {
      const m = modeRef.current;
      if (m === 'off') return;
      // Append to rolling buffer
      const next = (partialRef.current + ' ' + piece).trim();
      partialRef.current = next;
      setPartial(next);
      setInterim('');
      interimRef.current = '';

      if (m === 'dictation') {
        // Wait for user to send; keep partial visible
        return;
      }

      // Debounce auto-send on end-of-utterance
      clearDebounce();
      debounceRef.current = window.setTimeout(() => {
        const full = partialRef.current.trim();
        partialRef.current = '';
        setPartial('');
        if (full) commitUtterance(full);
      }, cfgRef.current.utteranceEndMs);
    },
    [commitUtterance]
  );

  function startListeningInternal(): void {
    const engine = cfgRef.current.sttEngine;
    if (engine === 'off') {
      setSttStatus('unsupported');
      setError('Voice STT is disabled (codeBuild.voice.sttEngine: off).');
      return;
    }

    stopTts();
    sttRef.current?.stop();
    sttRef.current = null;
    cfgRef.current.onHostSttStop();
    lastHostFinalRef.current = { text: '', at: 0 };
    setError(undefined);

    if (engine === 'host') {
      setSttStatus('starting');
      cfgRef.current.onHostSttStart(cfgRef.current.lang);
      return;
    }

    // webview path
    if (!isSttSupported()) {
      setSttStatus('unsupported');
      setError(WEBVIEW_STT_UNSUPPORTED_MSG);
      return;
    }
    const session = new SttSession({
      lang: cfgRef.current.lang,
      continuous: true,
      interimResults: true,
      mediaPreflight: true,
      onStatus: (s, detail) => {
        setSttStatus(s);
        setListening(s === 'listening');
        if (s === 'error' && detail) setError(detail);
        if (s === 'listening') setError(undefined);
        if (s === 'unsupported' && detail) setError(detail);
      },
      onResult: (r) => {
        if (r.isFinal) onFinalTranscript(r.transcript);
        else {
          interimRef.current = r.transcript;
          setInterim(r.transcript);
        }
      }
    });
    sttRef.current = session;
    session.start();
  }

  const onHostSttResult = useCallback(
    (transcript: string, isFinal: boolean) => {
      if (modeRef.current === 'off') return;
      if (!isFinal) {
        interimRef.current = transcript;
        setInterim(transcript);
        return;
      }
      // Host (Apple Speech) reports the full utterance on final — not a delta.
      // Drop only consecutive identical finals within 1s (restart glitches).
      const t = transcript.trim();
      const now = Date.now();
      if (
        !t ||
        (t === lastHostFinalRef.current.text && now - lastHostFinalRef.current.at < 1000)
      ) {
        return;
      }
      lastHostFinalRef.current = { text: t, at: now };
      setInterim('');
      interimRef.current = '';
      onFinalTranscript(t);
    },
    [onFinalTranscript]
  );

  const onHostSttStatus = useCallback((status: SttStatus, detail?: string) => {
    setSttStatus(status);
    setListening(status === 'listening');
    if (status === 'error' && detail) setError(detail);
    if (status === 'listening') setError(undefined);
    if (status === 'unsupported' && detail) setError(detail);
    if (status === 'idle' && modeRef.current === 'off') setError(undefined);
  }, []);

  const setMode = useCallback(
    (next: VoiceMode) => {
      if (next === 'off') {
        stopAll();
        return;
      }
      setModeState(next);
      modeRef.current = next;
      setError(undefined);
      if (next === 'ideation') {
        cfgRef.current.onStartVis();
      }
      startListeningInternal();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stopAll]
  );

  const toggleDictation = useCallback(() => {
    if (modeRef.current === 'dictation' && listening) {
      // Stop listening but keep mode until cleared
      const leftover = partialRef.current.trim();
      stopStt();
      setModeState('off');
      modeRef.current = 'off';
      // If there is leftover text, leave it in partial for composer
      if (leftover) {
        setPartial(leftover);
      }
      return;
    }
    setMode('dictation');
  }, [listening, setMode, stopStt]);

  const toggleInteractive = useCallback(() => {
    if (modeRef.current === 'interactive') {
      stopAll();
      return;
    }
    setMode('interactive');
  }, [setMode, stopAll]);

  const startIdeation = useCallback(() => {
    if (modeRef.current === 'ideation') {
      // End VIS
      cfgRef.current.onEndVis();
      stopAll();
      return;
    }
    setMode('ideation');
  }, [setMode, stopAll]);

  const flushPartial = useCallback(() => {
    const t = (partialRef.current + ' ' + interimRef.current).trim();
    partialRef.current = '';
    interimRef.current = '';
    setPartial('');
    setInterim('');
    return t;
  }, []);

  const onTurnComplete = useCallback(
    (assistantText: string) => {
      if (modeRef.current === 'off' || modeRef.current === 'dictation') return;
      if (!assistantText.trim()) {
        // Resume listen immediately
        if (!busyRef.current && (modeRef.current === 'interactive' || modeRef.current === 'ideation')) {
          startListeningInternal();
        }
        return;
      }
      speakReply(assistantText);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speakReply]
  );

  const onBusyChange = useCallback((busy: boolean) => {
    busyRef.current = busy;
    // While agent is working, pause continuous listen so we don't self-trigger
    // on ambient noise; user can still barge-in by flipping dictation.
    if (busy && (modeRef.current === 'interactive' || modeRef.current === 'ideation')) {
      clearDebounce();
      sttRef.current?.stop();
      cfgRef.current.onHostSttStop();
      setListening(false);
    }
  }, []);

  const onHostTtsDone = useCallback(() => {
    setSpeaking(false);
    speakingRef.current = false;
    if (
      (modeRef.current === 'interactive' || modeRef.current === 'ideation') &&
      !busyRef.current
    ) {
      startListeningInternal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearDebounce();
      sttRef.current?.stop();
      cfgRef.current.onHostSttStop();
      stopWebSpeech();
    };
  }, []);

  const sttEngine = cfg.sttEngine;
  const supported =
    sttEngine === 'host'
      ? cfg.hostSttAvailable
      : sttEngine === 'webview'
        ? isSttSupported()
        : false;

  return {
    mode,
    sttStatus,
    listening,
    speaking,
    interim,
    partial,
    supported,
    ttsSupported: isTtsSupported(),
    sttEngine,
    error,
    setMode,
    toggleDictation,
    toggleInteractive,
    startIdeation,
    stopAll,
    flushPartial,
    onTurnComplete,
    onBusyChange,
    onHostTtsDone,
    onHostSttResult,
    onHostSttStatus
  };
}
