import type { WebviewToHost } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi() may be called only once per webview load.
const api: VsCodeApi = acquireVsCodeApi();

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}

export function getState<T>(): T | undefined {
  return api.getState<T>();
}

export function setState<T>(state: T): void {
  api.setState(state);
}
