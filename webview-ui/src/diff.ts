// Moved to src/shared/diff.ts so the host-side session ledger can compute
// the same +/- counts the webview renders. Re-exported here so webview
// imports (`./diff`, `../diff`) keep working unchanged.
export * from '../../src/shared/diff';
