import { useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

// Open links in the system browser (webview anchors otherwise do nothing useful).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Render markdown as sanitized HTML.
 *
 * When `streaming` is true, re-parse at most every ~100ms so long answers
 * don't pay marked+DOMPurify on every token. Between ticks we still show
 * the last parsed HTML (or plain text on the very first chunk).
 */
export function Markdown({
  text,
  className,
  streaming
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  const lastFullAt = useRef(0);
  const cachedHtml = useRef('');
  const cachedFor = useRef('');

  const html = useMemo(() => {
    if (!text) return '';
    if (!streaming) {
      const raw = marked.parse(text, { async: false }) as string;
      const out = DOMPurify.sanitize(raw);
      cachedHtml.current = out;
      cachedFor.current = text;
      lastFullAt.current = performance.now();
      return out;
    }
    if (text === cachedFor.current && cachedHtml.current) {
      return cachedHtml.current;
    }
    const now = performance.now();
    if (cachedHtml.current && now - lastFullAt.current < 100) {
      return cachedHtml.current;
    }
    const raw = marked.parse(text, { async: false }) as string;
    const out = DOMPurify.sanitize(raw);
    cachedHtml.current = out;
    cachedFor.current = text;
    lastFullAt.current = now;
    return out;
  }, [text, streaming]);

  if (streaming && !html && text) {
    return (
      <div className={`markdown markdown-streaming-plain ${className ?? ''}`}>
        <pre className="markdown-plain">{text}</pre>
      </div>
    );
  }

  return (
    <div
      className={`markdown ${streaming ? 'markdown-streaming' : ''} ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
