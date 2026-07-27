import type { VoiceControllerApi } from '../voice/useVoiceController';

interface Props {
  voice: VoiceControllerApi;
  voiceEnabled: boolean;
  visActive: boolean;
  onEndVis: () => void;
}

export function VoiceBar({ voice, voiceEnabled, visActive, onEndVis }: Props) {
  if (!voiceEnabled) return null;

  const modeLabel =
    voice.mode === 'off'
      ? 'Voice off'
      : voice.mode === 'dictation'
        ? 'Dictation'
        : voice.mode === 'interactive'
          ? 'Hands-free'
          : 'Ideation (VIS)';

  const statusBits: string[] = [];
  if (voice.listening) statusBits.push('listening');
  if (voice.speaking) statusBits.push('speaking');
  if (voice.sttStatus === 'unsupported') statusBits.push('STT unavailable');
  if (visActive || voice.mode === 'ideation') statusBits.push('VIS');

  return (
    <div className={`voice-bar${voice.mode !== 'off' ? ' voice-bar-active' : ''}`}>
      <div className="voice-bar-modes">
        <button
          type="button"
          className={`voice-btn${voice.mode === 'dictation' ? ' voice-btn-on' : ''}${
            voice.listening && voice.mode === 'dictation' ? ' voice-btn-pulse' : ''
          }`}
          title="Dictation — fill the composer from your voice"
          onClick={() => voice.toggleDictation()}
        >
          {voice.listening && voice.mode === 'dictation' ? '● Mic' : 'Mic'}
        </button>
        <button
          type="button"
          className={`voice-btn${voice.mode === 'interactive' ? ' voice-btn-on' : ''}${
            voice.listening && voice.mode === 'interactive' ? ' voice-btn-pulse' : ''
          }`}
          title="Hands-free — always listen, auto-send, read replies aloud"
          onClick={() => voice.toggleInteractive()}
        >
          Hands-free
        </button>
        <button
          type="button"
          className={`voice-btn voice-btn-vis${
            voice.mode === 'ideation' || visActive ? ' voice-btn-on' : ''
          }${voice.listening && voice.mode === 'ideation' ? ' voice-btn-pulse' : ''}`}
          title="Voice Ideation Session — ramble, extract ideas into KP"
          onClick={() => {
            if (voice.mode === 'ideation' || visActive) {
              onEndVis();
              voice.stopAll();
            } else {
              voice.startIdeation();
            }
          }}
        >
          {voice.mode === 'ideation' || visActive ? 'End VIS' : 'VIS'}
        </button>
        {voice.mode !== 'off' && (
          <button
            type="button"
            className="voice-btn voice-btn-stop"
            title="Stop all voice activity"
            onClick={() => voice.stopAll()}
          >
            Stop
          </button>
        )}
      </div>
      <div className="voice-bar-status" title={voice.error ?? modeLabel}>
        <span className="voice-mode-label">{modeLabel}</span>
        {statusBits.length > 0 && (
          <span className="voice-status-bits"> · {statusBits.join(' · ')}</span>
        )}
        {voice.sttEngine === 'host' && (
          <span className="voice-status-bits"> · host STT</span>
        )}
        {voice.sttEngine === 'webview' && (
          <span className="voice-status-bits"> · webview STT</span>
        )}
        {!voice.supported && (
          <span className="voice-warn">
            {' '}
            · STT unavailable — use OS dictation (double-tap Fn) in the composer
          </span>
        )}
      </div>
      {(voice.interim || voice.partial) && voice.mode !== 'off' && (
        <div className="voice-transcript">
          {voice.partial && <span className="voice-partial">{voice.partial}</span>}
          {voice.interim && <span className="voice-interim"> {voice.interim}</span>}
        </div>
      )}
      {voice.error && <div className="voice-error">{voice.error}</div>}
    </div>
  );
}
