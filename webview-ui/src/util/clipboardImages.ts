import type { ImageAttachment } from '../store';

/** MIME types we will attach. SVG is rejected (XSS). */
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

export function isAllowedImageMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (m === 'image/jpg') return true;
  return IMAGE_MIME.has(m);
}

export function normalizeMime(mime: string | undefined, name?: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  if (IMAGE_MIME.has(m)) return m === 'image/jpg' ? 'image/jpeg' : m;
  const n = (name || '').toLowerCase();
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

export function clipboardLooksLikeImage(data: DataTransfer | null | undefined): boolean {
  if (!data) return false;
  const types = Array.from(data.types ?? []);
  if (
    types.some(
      (t) =>
        t.startsWith('image/') ||
        t === 'Files' ||
        /png|jpeg|jpg|gif|webp|tiff/i.test(t)
    )
  ) {
    return true;
  }
  if (data.files) {
    for (let i = 0; i < data.files.length; i++) {
      const f = data.files[i];
      if (f && (isAllowedImageMime(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name))) return true;
    }
  }
  const html = safeGet(data, 'text/html');
  if (/<img[\s>]/i.test(html)) return true;
  return false;
}

export function collectClipboardImageFiles(data: DataTransfer): File[] {
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null | undefined) => {
    if (!f) return;
    const mime = normalizeMime(f.type, f.name);
    if (!isAllowedImageMime(mime) && !/\.(png|jpe?g|gif|webp)$/i.test(f.name)) return;
    const key = `${f.name}:${f.size}:${f.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  if (data.files) {
    for (let i = 0; i < data.files.length; i++) add(data.files[i]);
  }
  if (data.items) {
    for (let i = 0; i < data.items.length; i++) {
      const it = data.items[i];
      if (it.type.startsWith('image/') || it.kind === 'file') add(it.getAsFile());
    }
  }
  return out;
}

/** Pull data-URI <img> tags out of clipboard HTML (some apps copy a bitmap
 * plus HTML, or only HTML with an embedded image). */
export function extractImagesFromHtml(html: string): ImageAttachment[] {
  if (!html) return [];
  const out: ImageAttachment[] = [];
  const re = /<img\b[^>]*\bsrc=["'](data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+))["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const mime = normalizeMime(m[2]);
    if (!isAllowedImageMime(mime)) continue;
    out.push({ mimeType: mime, data: m[3], name: `pasted-${out.length + 1}` });
  }
  return out;
}

export type PasteDecision =
  | { kind: 'images'; files: File[]; inline: ImageAttachment[] }
  | { kind: 'probe'; fallbackText: string };

/**
 * Decide what a composer paste should do.
 *
 * If the event carries an image (file item, Files list, or HTML data-URI),
 * take the image and drop leftover text/plain — macOS often keeps the
 * previous copy's text flavor next to a newly copied screenshot.
 * Otherwise ask the host to read the OS clipboard (VS Code webviews
 * frequently strip image items from the paste event).
 */
export function decidePaste(data: DataTransfer | null | undefined): PasteDecision {
  if (!data) return { kind: 'probe', fallbackText: '' };
  const files = collectClipboardImageFiles(data);
  const inline = extractImagesFromHtml(safeGet(data, 'text/html'));
  const text = safeGet(data, 'text/plain');
  if (files.length > 0 || inline.length > 0) return { kind: 'images', files, inline };
  return { kind: 'probe', fallbackText: text };
}

export function dataUrlToAttachment(dataUrl: string, name?: string): ImageAttachment | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const mime = normalizeMime(m[1]);
  if (!isAllowedImageMime(mime)) return null;
  return { mimeType: mime, data: m[2], name };
}

function safeGet(data: DataTransfer, type: string): string {
  try {
    return data.getData(type) || '';
  } catch {
    return '';
  }
}
