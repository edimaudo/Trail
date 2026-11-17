import { build } from 'esbuild';
import { cp, mkdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const outDir = new URL('../dist/', import.meta.url);
await rm(outDir, { recursive: true, force: true });
await mkdir(new URL('../dist/assets/', import.meta.url), { recursive: true });
await build({
  entryPoints: [new URL('../src/main.ts', import.meta.url).pathname],
  bundle: true,
  outdir: new URL('../dist/assets/', import.meta.url).pathname,
  entryNames: 'main',
  assetNames: 'assets/[name]-[hash]',
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development') },
  logLevel: 'info'
});
await copyFile(new URL('../index.html', import.meta.url), new URL('../dist/index.html', import.meta.url));
if (existsSync(new URL('../public/', import.meta.url))) {
  await cp(new URL('../public/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
}
console.log('Trail frontend built in dist/ (vanilla HTML + TypeScript + CSS).');
