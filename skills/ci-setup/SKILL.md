---
name: ci-setup
description: Set up a GitHub Actions workflow in a source repository so every pull request that touches the schema files gets one comment showing how the ERD would change (summary, table of changes, what still needs /open-erd:sync, link to diff.svg), computed without AI from the open-erd extract script. Comment only; nothing is pushed to the ERD workspace. Use when the user wants the ERD checked, previewed or kept from going stale in CI or on pull requests.
---

# ci-setup

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md`.

The workflow is `${CLAUDE_PLUGIN_ROOT}/skills/ci-setup/workflow.yml`. Fill
its `__NAME__` placeholders; change nothing else in it.

## 1. Collect

- Workspace (rules.md). The source: one of `sources` in `open-erd.yaml`
  (several → ask which repository gets the workflow); its path from
  `open-erd.local.yaml`.
- `extract/<source>.mjs` and `extract/facts/*.json` must be committed in the
  workspace (`git -C <ws> ls-files extract`); the workflow reads them from
  there. Missing or uncommitted → run `/open-erd:sync` and commit first.
- `__SOURCE__`: the source name.
- `__WORKSPACE_REPO__`: `<owner>/<repo>` from `git -C <ws> remote get-url origin`
  (GitHub only; no GitHub remote → ask, and say the workspace must be pushed
  there for CI to read it).
- `__WORKSPACE_REF__`: the workspace branch the ERD is kept on
  (`git -C <ws> rev-parse --abbrev-ref HEAD`, usually `main`).
- `__WORKSPACE_DIR__`: the workspace inside its repository,
  `git -C <ws> rev-parse --show-prefix` without the trailing `/`; empty → `.`.
- `__OPEN_ERD_REF__`: the commit of this plugin, so CI runs the engine the
  user runs: `git -C <plugin root> rev-parse HEAD`; not a git checkout →
  `git ls-remote https://github.com/TOMOSIA-VIETNAM/open-erd HEAD` (read
  only) and say it pins today's latest version.
- `__PATHS__`: what the extract script reads, as quoted globs relative to
  the source root, comma-separated: read `extract/<source>.mjs` and list
  every file it opens and every directory it walks (`'db/schema.rb'`,
  `'app/models/**'`, `'prisma/schema.prisma'`), plus
  `'.github/workflows/open-erd.yml'`. Show the list with the line of the
  script each comes from.

## 2. Show, then write only with consent

Show the filled workflow in full, then explain in the user's language:

- What it does: on a pull request touching those paths it runs the extract
  script on the pull request's code, applies table, column, index and
  foreign-key changes to a temporary copy of the ERD (`apply-facts`), and
  posts or updates one comment: the summary line, a table of changes, the
  list left for `/open-erd:sync` (renames, domains and notes of new tables,
  relations without a constraint, anything a reviewed fact uses) and a link
  to `diff.svg`/`diff.xlsx` in the run's artifacts. It writes nothing to the
  workspace; after merging, someone runs `/open-erd:sync` as before.
- Token: in GitHub, create a fine-grained personal access token (or a
  GitHub App installed on the workspace repository) with access to only
  `__WORKSPACE_REPO__` and permission **Contents: Read-only**. In the source
  repository: Settings → Secrets and variables → Actions → New repository
  secret, name `OPEN_ERD_WORKSPACE_TOKEN`. Commenting needs no secret: the
  workflow asks `pull-requests: write` for its own `GITHUB_TOKEN`. Pull
  requests from forks are skipped (they get neither).
- Updating: after a plugin update, rerun `/open-erd:ci-setup` to move
  `__OPEN_ERD_REF__`; extract script changes need nothing (CI reads them
  from the workspace).

Ask: "Write it to `<source path>/.github/workflows/open-erd.yml`?" On yes,
write that one file: it is the only write into a source repository any
open-erd command makes, and only with this consent. Never commit, push,
create the secret or call the GitHub API: tell the user to review, commit
and add the secret themselves. On no, the printed workflow is the result.

End with the feedback line.
