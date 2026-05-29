// Bundles the extension host (src/extension.ts) into dist/extension.js (CommonJS).
// vscode is provided by the runtime and must stay external.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
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

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching host...');
  } else {
    await esbuild.build(options);
    console.log('[esbuild] host build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
