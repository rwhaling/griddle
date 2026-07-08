import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const strudel = (pkg, entry) =>
  fileURLToPath(new URL(`../strudel/packages/${pkg}/${entry}`, import.meta.url));

// Point at the strudel monorepo source (cloned as a sibling of this project).
// The published npm dist bundles drag in a broken @kabelsalat/web import, and
// the workspace:* protocol blocks a file: install, so we alias to source.
export default defineConfig({
  resolve: {
    alias: [
      // subpath aliases must precede the bare-package alias
      { find: /^@strudel\/core\/(.*)$/, replacement: strudel('core', '$1') },
      { find: '@strudel/core', replacement: strudel('core', 'index.mjs') },
      { find: '@strudel/mini', replacement: strudel('mini', 'index.mjs') },
      // the strudel sources live outside this project root, so their bare
      // imports must be pinned to our installed copies
      {
        find: 'fraction.js',
        replacement: fileURLToPath(new URL('./node_modules/fraction.js/dist/fraction.mjs', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
  },
});
