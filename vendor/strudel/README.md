# Vendored strudel packages

Source-vendored from the [strudel](https://github.com/tidalcycles/strudel)
monorepo at commit `95a9d301a1f311863eda1d0c7037b65d9d90da14`:

- `packages/core` — Pattern/Hap/TimeSpan, signals, controls
- `packages/mini` — mini-notation parser (krill)
- `packages/transpiler` — JS transpiler (labeled statements, mini-string
  wrapping)
- `packages/superdough` — the WebAudio synth engine (synth devices,
  doc nine); `examples`/`dist` pruned
- `packages/vite-plugin-bundle-audioworklet` — resolves superdough's
  `?audioworklet` imports at build time

Vendored because the published npm dist bundles carry a broken
`@kabelsalat/web` import; consuming the source directly (via aliases in
`../../vite.config.js`) is what griddle has been developed and tested
against. Test/bench directories pruned.

**Local deltas** (kept deliberately minimal; each marked with a
`griddle local delta` comment at the site):

- `vite-plugin-bundle-audioworklet`: the inner worklet build now inherits
  the host config's `resolve` (aliases), so `@kabelsalat/lib` resolves
  when the worklet entry lives outside the project root. Worth offering
  upstream.
- `@kabelsalat/web` is aliased to a stub (`src/stubs/`) rather than
  installed — it is only reached via superdough's dynamic import for
  kabelsalat-dsp sounds, which griddle does not expose. `@kabelsalat/lib`
  (worklet ugens table) and `nanostores` are real npm dependencies.

Strudel is licensed **AGPL-3.0** — see `LICENSE` in this directory. That
license extends to distributed builds of griddle that include this code.
