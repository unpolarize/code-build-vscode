import { useEffect, useState } from 'react';
import { formatNowLine } from '../../../src/shared/nowLine';

interface Props {
  now: { verb: string; target: string; startedAtMs: number } | null;
}

/** Progressive tool-activity strip: `now: <verb> <target> · <elapsed>s`,
 * a single line above the composer. Isolated from MessageList — the 1 Hz
 * elapsed tick re-renders only this component, off wall-clock
 * `Date.now() - startedAtMs` (the host posts nothing between tool
 * open/close transitions). The timer pauses while the tab is hidden. */
export function NowLine({ now }: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!now) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!timer) timer = setInterval(() => setTick((t) => t + 1), 1000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [now]);
  if (!now) return null;
  const elapsed = Math.max(0, Math.round((Date.now() - now.startedAtMs) / 1000));
  const line = formatNowLine(now);
  return (
    <div className="now-line" aria-live="polite" title={`${now.verb} ${now.target}`}>
      <span className="now-line-label">now:</span>
      <span className="now-line-text">{line}</span>
      <span className="now-line-elapsed">· {elapsed}s</span>
    </div>
  );
}
