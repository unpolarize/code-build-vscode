import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface ClipboardImage {
  mimeType: string;
  data: string;
  name: string;
}

/** Validate a clipboard dump and return base64 + mime, or null. */
export function encodeClipboardImageBuffer(buf: Buffer): ClipboardImage | null {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', data: buf.toString('base64'), name: 'clipboard.png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', data: buf.toString('base64'), name: 'clipboard.jpg' };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { mimeType: 'image/gif', data: buf.toString('base64'), name: 'clipboard.gif' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', data: buf.toString('base64'), name: 'clipboard.webp' };
  }
  return null;
}

/**
 * Read an image from the OS clipboard. VS Code webviews often omit image
 * items from the paste event while leaving stale text/plain; the host
 * clipboard is the source of truth for a screenshot / Finder copy.
 */
export async function readOsClipboardImage(timeoutMs = 2500): Promise<ClipboardImage | null> {
  try {
    if (process.platform === 'darwin') return await withTimeout(readMacClipboardImage(), timeoutMs);
    if (process.platform === 'win32') return await withTimeout(readWinClipboardImage(), timeoutMs);
    return await withTimeout(readLinuxClipboardImage(), timeoutMs);
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('clipboard timeout')), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readMacClipboardImage(): Promise<ClipboardImage | null> {
  const out = path.join(os.tmpdir(), `cb-clip-${process.pid}-${Date.now()}.png`);
  const script = [
    `set outPath to POSIX file ${JSON.stringify(out)}`,
    'try',
    '  set pngData to (the clipboard as «class PNGf»)',
    '  set f to open for access outPath with write permission',
    '  set eof f to 0',
    '  write pngData to f',
    '  close access f',
    '  return "ok"',
    'on error',
    '  try',
    '    close access outPath',
    '  end try',
    '  return ""',
    'end try'
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 2000 });
    if (!String(stdout).includes('ok') || !fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out);
    return encodeClipboardImageBuffer(buf);
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* ignore */
    }
  }
}

async function readWinClipboardImage(): Promise<ClipboardImage | null> {
  const out = path.join(os.tmpdir(), `cb-clip-${process.pid}-${Date.now()}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { exit 1 }',
    `$img.Save(${JSON.stringify(out)}, [System.Drawing.Imaging.ImageFormat]::Png)`
  ].join('; ');
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 2000 });
    if (!fs.existsSync(out)) return null;
    return encodeClipboardImageBuffer(fs.readFileSync(out));
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* ignore */
    }
  }
}

async function readLinuxClipboardImage(): Promise<ClipboardImage | null> {
  const tryCmd = async (cmd: string, args: string[]): Promise<ClipboardImage | null> => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { encoding: 'buffer', timeout: 2000, maxBuffer: 20 * 1024 * 1024 } as any);
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      return encodeClipboardImageBuffer(buf);
    } catch {
      return null;
    }
  };
  return (
    (await tryCmd('wl-paste', ['-t', 'image/png'])) ||
    (await tryCmd('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']))
  );
}
