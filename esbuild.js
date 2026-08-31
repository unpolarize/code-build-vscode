// Bundles the extension host (src/extension.ts) into dist/extension.js (CommonJS).
// vscode is provided by the runtime and must stay external.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

/** Separate Node child — no vscode. Forked on restore so JSONL parse
 * does not run on the extension-host event loop. */
const workerOptions = {
  entryPoints: ['src/host/persistence/transcriptWorker.ts'],
  bundle: true,
  outfile: 'dist/transcriptWorker.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

async function main() {
  if (watch) {
    const hostCtx = await esbuild.context(hostOptions);
    const workerCtx = await esbuild.context(workerOptions);
    await Promise.all([hostCtx.watch(), workerCtx.watch()]);
    console.log('[esbuild] watching host + transcriptWorker...');
  } else {
    await Promise.all([esbuild.build(hostOptions), esbuild.build(workerOptions)]);
    console.log('[esbuild] host + transcriptWorker build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
