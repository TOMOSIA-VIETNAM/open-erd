# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

open-erd is a Claude Code plugin that draws an ERD from any project's source code. Three parts:

- **Skills** (`skills/<name>/SKILL.md`, registered by directory; no list in `.claude-plugin/plugin.json`): the AI side. Claude writes a read-only extract script per source repo, turns its facts into `model/*.yaml`, and calls the engine. Shared rules live once in `skills/_shared/rules.md` (workflow, approvals, verification) and `skills/_shared/model.md` (model format, facts file format); skills point to sections there instead of repeating them.
- **Adapter layer** (other agents, e.g. Codex): `.agents/skills/open-erd-<cmd>/SKILL.md` (one short entry per command), `adapters/root.md` (resolves the plugin root, maps Claude Code tool and command names; the only file naming another platform), `.codex-plugin/`, `.agents/plugins/`, `install.sh`, `scripts/install-local.sh`. **Adapters carry no behaviour**: an entry only says "read `ROOT/skills/<cmd>/SKILL.md` and follow it"; every rule stays in `skills/`. A new command needs a new entry (its `description` mirrors the skill's, with `$open-erd-<cmd>` for `/open-erd:<cmd>`); a file the skills newly read at run time goes into `SHIP` in `install.sh`. `engine/test/platform-layer.test.js` enforces all of this. Never put these entries under `skills/`: Claude Code registers every directory there as a command.
- **Engine** (`engine/`, Node ≥ 20.10, ESM): deterministic, no AI. Model → layout → SVG / XLSX / draw.io / diff. Bundled to `dist/open-erd.mjs`, which is **committed** and is what skills and CI run.

## Commands

```bash
cd engine
npm ci
npm test                          # node --test, all of engine/test
node --test test/health.test.js   # one file
node --test --test-name-pattern "orphan" test/health.test.js   # one test
npm run test:large                # 1000-table / 500-tenant scale tests
npm run build                     # bundle-viewer + esbuild → ../dist/open-erd.mjs (commit it)
npm run bundle-viewer             # only regenerate src/render/svg/viewer-bundle.json
npm run eval                      # Claude headless over fixtures/ — costs API usage, run only when asked
```

Viewer changes need a real browser check (Chrome headless; `CHROME_PATH` overrides the binary):

```bash
node dist/open-erd.mjs layout --workspace <ws>   # a fresh copy of a fixture has no layout.json
node dist/open-erd.mjs render --workspace <ws>
node engine/scripts/verify-viewer.js <ws>/out/erd.svg <shots dir>     # scripted interactions, ends "viewer OK"
node engine/scripts/screenshot-views.js <ws>/out/erd.svg <shots dir>  # PNG of every view
```

Render into a copy (e.g. of `engine/test/fixtures/workspace-multi`), not the fixture itself. Look at the PNGs; a passing script is not a layout check. `verify-viewer` fails on a single-domain workspace (`workspace-valid`) at the overview connector step; that is a limitation of the script.

Engine CLI (`node dist/open-erd.mjs --help`): `validate`, `lock`, `verify`, `apply-facts`, `facts-diff [--from <ref>] [--format json]`, `layout`, `render [--profile]`, `diff --from <ref> --to <ref|WORKTREE> | --to-workspace <dir> [--format markdown]`.

## Engine architecture

- **I/O only in `engine/cli.js`**; everything under `src/` is pure (files in as `{ relativePath: text }`, results out). Keep it that way: tests rely on it.
- **`src/model/schema.js` is the single source** for config and model fields (`open-erd.yaml` keys such as `verify`, `not_in_model`, `health.ignore`, `profiles`, `outputs`; workspace file paths like `tests/locked.yaml`, `tests/verification.yaml`). The validator is hand-written (`load.js`, `validate.js`); no ajv. New config keys go into schema.js + validator + `docs/USAGE.md`.
- **Model → render pipeline**: `load.js` parses/validates/normalizes → `profile.js` filters for a sharing profile (the `public` profile drops hidden tables, `pii` columns, evidence, internal notes; anything derived, like Health findings or the Verification sheet, must be filtered too) → `layout/` → `render/svg`, `render/xlsx`, `render/drawio`.
- **Layout**: ELK only orders clusters; final coordinates and orthogonal routing are own code (`router.js`). `layout.json` keeps positions per view with stability rules (`stability.js`); only the `layout` command writes it, `render` never does and stops if it is out of date.
- **Determinism is a contract**: same inputs → byte-identical SVG/XLSX/drawio (fixed zip mtimes, document dates from the workspace's HEAD commit, sorted output). `test/determinism.test.js` renders 100×.
- **Facts**: `model/facts.js` `compareFacts(model, facts)` returns structural deltas (tables, columns, indexes, `db_fk` relations) between the model and `extract/facts/*.json`. `verify` reports them; `apply-facts` (`model/apply-facts.js`) applies the mechanical ones to a workspace copy via the `yaml` Document API (keeps comments) and lists the rest as needing `/open-erd:sync`. Used by the CI workflow template `skills/ci-setup/workflow.yml`.
- **Diff**: reads both sides with `git show <ref>:<path>` (no checkout); `diff/changes.js` is the only place English change sentences are written; `diff/union.js` merges both sides for `diff.svg`.

## Viewer

- Source: `engine/src/render/svg/viewer/` (`index.js` is large; pure helpers in sibling modules such as `join-path.js`, `tour.js`, `pii.js`, `palette.js`, `deep-link.js`, each with a node test). CSS lives in `src/render/svg/render.js`.
- It is bundled into `src/render/svg/viewer-bundle.json` and inlined into every `erd.svg` together with the model data. **After editing the viewer run `npm run build`**; `test/viewer.test.js` fails when the committed bundle is stale.
- The SVG must still show a static view without JavaScript; downloads (`viewAsSvg`) save the view as it is on screen, without overlays.
- Overlays are `foreignObject`s positioned in `layoutOverlays()`. Keyboard shortcuts are listed in `SHORTCUTS` (shown by the `?` button/key) and in `docs/USAGE.md`; keep both in sync with the keydown handler.

## Conventions

- Deps are limited to `elkjs`, `exceljs`, `yaml`; do not add more.
- Text widths come from committed Inter metrics (`src/text/`), not the DOM.
- Skills never read DB credentials and only run extract scripts after approval (rules in `skills/_shared/rules.md`). Every AI-written model change is verified by a second agent before commit (`rules.md`, "Verification"; prompt in `skills/_shared/verifier.md`).
- `fixtures/<stack>/` are small source apps with hand-written `expected/` models, scored by `evals/`.
- Docs: `README.md` is short and for users; details go to `docs/USAGE.md`, developer notes to `docs/DEVELOPMENT.md`. `notebooks/` (git-ignored, local only) holds plans and specs. Code, comments, skills and docs must not reference backlog items or their numbering.
- The repo is public: never copy a real project's workspace, model or screenshots into it.
