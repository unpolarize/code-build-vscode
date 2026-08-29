import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipboardLooksLikeImage,
  decidePaste,
  extractImagesFromHtml,
  isAllowedImageMime,
  normalizeMime
} from '../../webview-ui/src/util/clipboardImages';
import { encodeClipboardImageBuffer } from '../../src/host/clipboardImage';

function dt(opts: {
  types?: string[];
  text?: string;
  html?: string;
  files?: Array<{ name: string; type: string; size?: number }>;
}): DataTransfer {
  const files = opts.files ?? [];
  const items = files.map((f) => ({
    kind: 'file' as const,
    type: f.type,
    getAsFile: () => ({ name: f.name, type: f.type, size: f.size ?? 10 }) as File
  }));
  const types = opts.types ?? [
    ...(opts.text != null ? ['text/plain'] : []),
    ...(opts.html != null ? ['text/html'] : []),
    ...(files.length ? ['Files', ...files.map((f) => f.type)] : [])
  ];
  return {
    types,
    files: files as unknown as FileList,
    items: items as unknown as DataTransferItemList,
    getData: (t: string) => {
      if (t === 'text/plain') return opts.text ?? '';
      if (t === 'text/html') return opts.html ?? '';
      return '';
    }
  } as unknown as DataTransfer;
}

describe('clipboard image paste', () => {
  it('rejects SVG and allows png/jpeg/gif/webp', () => {
    assert.equal(isAllowedImageMime('image/png'), true);
    assert.equal(isAllowedImageMime('image/svg+xml'), false);
    assert.equal(normalizeMime('image/jpg'), 'image/jpeg');
  });

  it('prefers a clipboard image over leftover text/plain', () => {
    const data = dt({
      text: 'Sending a prompt is still hitting the idle-restore path',
      files: [{ name: 'shot.png', type: 'image/png', size: 99 }]
    });
    const d = decidePaste(data);
    assert.equal(d.kind, 'images');
    if (d.kind === 'images') {
      assert.equal(d.files.length, 1);
      assert.equal(d.files[0].name, 'shot.png');
    }
  });

  it('extracts a data-URI img from HTML even when text/plain is stale', () => {
    const html = '<img src="data:image/png;base64,ZmFrZQ==" alt="x">';
    const inline = extractImagesFromHtml(html);
    assert.equal(inline.length, 1);
    assert.equal(inline[0].data, 'ZmFrZQ==');
    const d = decidePaste(dt({ text: 'stale assistant paragraph', html }));
    assert.equal(d.kind, 'images');
  });

  it('inserts text-only paste in the webview (no host probe)', () => {
    const d = decidePaste(dt({ text: 'hello world' }));
    assert.equal(d.kind, 'text');
    if (d.kind === 'text') assert.equal(d.text, 'hello world');
  });

  it('probes when types look like an image even if text/plain leftover', () => {
    const d = decidePaste(dt({ types: ['image/png', 'text/plain'], text: 'stale assistant paragraph' }));
    assert.equal(d.kind, 'probe');
    if (d.kind === 'probe') assert.equal(d.fallbackText, 'stale assistant paragraph');
  });

  it('probes when clipboardData is missing', () => {
    const d = decidePaste(null);
    assert.equal(d.kind, 'probe');
  });

  it('clipboardLooksLikeImage is true for Files / image types', () => {
    assert.equal(clipboardLooksLikeImage(dt({ types: ['image/png', 'text/plain'] })), true);
    assert.equal(clipboardLooksLikeImage(dt({ text: 'only text' })), false);
  });
});

describe('encodeClipboardImageBuffer', () => {
  it('accepts PNG magic and rejects garbage', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(20).fill(0)]);
    const got = encodeClipboardImageBuffer(png);
    assert.equal(got?.mimeType, 'image/png');
    assert.equal(encodeClipboardImageBuffer(Buffer.from('not-an-image-at-all-bytes!!')), null);
  });
});
