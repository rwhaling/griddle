# Vendored strudel packages

Source-vendored from the [strudel](https://github.com/tidalcycles/strudel)
monorepo at commit `95a9d301a1f311863eda1d0c7037b65d9d90da14`:

- `packages/core` — Pattern/Hap/TimeSpan, signals, controls
- `packages/mini` — mini-notation parser (krill)
- `packages/transpiler` — JS transpiler (labeled statements, mini-string
  wrapping)

Vendored because the published npm dist bundles carry a broken
`@kabelsalat/web` import; consuming the source directly (via aliases in
`../../vite.config.js`) is what griddle has been developed and tested
against. Test/bench directories pruned; everything else unmodified.

Strudel is licensed **AGPL-3.0** — see `LICENSE` in this directory. That
license extends to distributed builds of griddle that include this code.
