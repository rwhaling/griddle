import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
// resolves superdough's `worklets.mjs?audioworklet` import by bundling the
// worklet file to a base64 data: URL; always the vendored copy (build tooling)
import bundleAudioWorkletPlugin from './vendor/strudel/packages/vite-plugin-bundle-audioworklet/vite-plugin-bundle-audioworklet.js';

// Strudel is consumed as source (the published npm dist bundles carry a
// broken import). The canonical copy is vendored in ./vendor/strudel; a
// sibling ../strudel monorepo checkout is preferred when present (the
// research-workspace setup), so local hacking on strudel still works.
const local = fileURLToPath(new URL('../strudel/packages', import.meta.url));
const vendored = fileURLToPath(new URL('./vendor/strudel/packages', import.meta.url));
const packagesRoot =
  !process.env.GRIDDLE_VENDORED && existsSync(local) ? local : vendored;
const strudel = (pkg, entry) => `${packagesRoot}/${pkg}/${entry}`;

export default defineConfig({
  // relative asset paths: works at rwhaling.github.io/griddle and locally
  base: './',
  plugins: [bundleAudioWorkletPlugin()],
  resolve: {
    alias: [
      // subpath aliases must precede the bare-package aliases
      { find: /^@strudel\/core\/(.*)$/, replacement: strudel('core', '$1') },
      { find: /^@strudel\/transpiler\/(.*)$/, replacement: strudel('transpiler', '$1') },
      { find: '@strudel/core', replacement: strudel('core', 'index.mjs') },
      { find: '@strudel/mini', replacement: strudel('mini', 'index.mjs') },
      { find: '@strudel/transpiler', replacement: strudel('transpiler', 'transpiler.mjs') },
      // superdough (renderer #0, doc nine): consumed as source like the rest
      { find: /^superdough$/, replacement: strudel('superdough', 'index.mjs') },
      // only reached via superdough's dynamic import for kabelsalat-dsp
      // sounds, which griddle doesn't expose — stubbed (its published dist
      // is the original vendoring culprit)
      {
        find: '@kabelsalat/web',
        replacement: fileURLToPath(new URL('./src/stubs/kabelsalat-web-stub.js', import.meta.url)),
      },
      // superdough's worklets import @kabelsalat/lib by bare specifier; pin
      // it to our installed copy so it resolves from the sibling checkout too
      {
        find: '@kabelsalat/lib',
        replacement: fileURLToPath(new URL('./node_modules/@kabelsalat/lib', import.meta.url)),
      },
      // when using the sibling checkout (outside the project root), its bare
      // imports must be pinned to our installed copies; harmless when vendored
      {
        find: 'fraction.js',
        replacement: fileURLToPath(new URL('./node_modules/fraction.js/dist/fraction.mjs', import.meta.url)),
      },
      {
        find: /^nanostores$/,
        replacement: fileURLToPath(new URL('./node_modules/nanostores/index.js', import.meta.url)),
      },
      {
        find: /^acorn$/,
        replacement: fileURLToPath(new URL('./node_modules/acorn/dist/acorn.mjs', import.meta.url)),
      },
      {
        find: /^escodegen$/,
        replacement: fileURLToPath(new URL('./node_modules/escodegen/escodegen.js', import.meta.url)),
      },
      {
        find: /^estree-walker$/,
        replacement: fileURLToPath(new URL('./node_modules/estree-walker/src/index.js', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
  },
});
