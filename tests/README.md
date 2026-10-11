# Test guide

Every executable test case uses `*.test.ts`. Helpers and consumer inputs live outside runner discovery.

- `unit/` checks deterministic source behavior with RSTest: geometry, bounds, movement, material configuration, effects, camera input, and shadow bookkeeping.
- `package/` checks built and packed artifacts with RSTest: isolated consumer compilation, ESM loading, declaration-map sources, packaged documentation, and the 20 KiB gzip delivery budget. These tests intentionally use the built package rather than source aliases.
- `browser/` checks real WebGL pixels, state preservation, resource ownership, caching, recovery, and demo controls with Playwright. Each case starts on a fresh page; the demo fixture pauses movement and resets the marker.
- `fixtures/` contains consumer inputs. `support/` contains reusable setup, assertions, package preparation, and browser scene helpers.

Run `pnpm typecheck` and `pnpm test` for the complete validation path. The default test command builds the library and demo once, runs both RSTest projects, then runs Playwright. Browser setup requires `pnpm exec playwright install chromium` once; `CHROME_PATH` can select an existing executable.

`pnpm test:list` uses native runner discovery to list every named case without builds or test setup.

For focused work:

```sh
pnpm test:list
pnpm test:unit
pnpm test:watch
pnpm test:package
pnpm test:browser
pnpm exec rstest run --project unit tests/unit/bounds.test.ts
pnpm exec rstest run --project package tests/package/publication.test.ts
pnpm exec playwright test tests/browser/library.test.ts
pnpm exec playwright test --grep 'context restoration'
```

Direct runner commands expect any required builds to exist. `pnpm validate:publication` is an alias for the package suite. `pnpm benchmark:movement` builds and runs the optional timing harness in `benchmarks/`; timings are observations, not hardware-dependent correctness thresholds.

Browser assets come from an ephemeral localhost server: `/lib/` serves `dist/`, the demo serves `demo-dist/`, and an explicit allowlist exposes test support TypeScript as browser ES modules. The support server does not rebuild product code. GPU helpers own and dispose test-created controllers, buffers, programs, VAOs, and contexts. Browser errors are asserted automatically by the page fixture; traces and screenshots are retained only on failure under `build/browser-results/`.

Retain cases that protect a distinct observable failure: numeric boundaries and invalid inputs at unit level; delivery/type compatibility at package level; pixels, host state, caching, and lifecycle in a browser WebGL context; controls and scheduling in the demo. Avoid repeating unit math in browser cases, constant success flags, fixture-only assertions, and timing thresholds. Separate cases need independent setup and names so a failure identifies the affected contract.
