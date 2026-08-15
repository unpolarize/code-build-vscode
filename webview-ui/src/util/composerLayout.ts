/** Persist composer height across webview reloads. */

export const COMPOSER_HEIGHT_KEY = 'cb.composerHeightPx';
export const COMPOSER_MAX_KEY = 'cb.composerMaximized';
export const COMPOSER_DEFAULT_HEIGHT = 112;
export const COMPOSER_MIN_HEIGHT = 72;
export const COMPOSER_MAX_FRACTION = 0.78;

export interface ComposerLayout {
  height: number;
  maximized: boolean;
}

function readNum(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function clampComposerHeight(height: number, panelHeight: number): number {
  const max = Math.max(
    COMPOSER_MIN_HEIGHT,
    Math.floor(panelHeight * COMPOSER_MAX_FRACTION)
  );
  return Math.min(max, Math.max(COMPOSER_MIN_HEIGHT, Math.round(height)));
}

export function maximizedComposerHeight(panelHeight: number): number {
  return clampComposerHeight(panelHeight * COMPOSER_MAX_FRACTION, panelHeight);
}

export function loadComposerLayout(): ComposerLayout {
  return {
    height: Math.max(COMPOSER_MIN_HEIGHT, readNum(COMPOSER_HEIGHT_KEY, COMPOSER_DEFAULT_HEIGHT)),
    maximized: readBool(COMPOSER_MAX_KEY)
  };
}

export function saveComposerLayout(layout: ComposerLayout): void {
  try {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(layout.height)));
    localStorage.setItem(COMPOSER_MAX_KEY, layout.maximized ? '1' : '0');
  } catch {
    /* private mode / denied storage — height just won't persist */
  }
}

export function isNearBottom(el: HTMLElement, slopPx = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slopPx;
}
