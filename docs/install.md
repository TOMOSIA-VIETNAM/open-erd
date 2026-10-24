# Install

[← README](../README.md)

Needs `node` 20.10 or later and `git`. `/open-erd:ci-setup` and `/open-erd:feedback` also need
[`gh`](https://cli.github.com/), logged in.

| Platform | Use |
| -------- | --- |
| Claude Code | `/open-erd:init`, `/open-erd:sync`, … |
| Codex | `$open-erd-init`, `$open-erd-sync`, … |

## Claude Code

From the plugin catalog, inside a session:

```
/plugin marketplace add TOMOSIA-VIETNAM/open-erd
/plugin install open-erd@open-erd
```

or from a shell: `claude plugin marketplace add TOMOSIA-VIETNAM/open-erd`, then
`claude plugin install open-erd@open-erd`.

Every commit to `main` is a new version (the plugin has no fixed `version` field, so Claude Code
follows the commit). Updates are off for this marketplace until you turn them on once: `/plugin` →
**Marketplaces** → **open-erd** → **Enable auto-update**. Claude Code then checks in the background
and asks you to run `/reload-plugins` when a new version arrives. By hand:

```
/plugin marketplace update open-erd
```

then `/plugin` → **Installed** → **open-erd** → **Update now**, and `/reload-plugins`.

From a shell: `claude plugin marketplace update open-erd`, then `claude plugin update open-erd@open-erd`.
An organisation can turn auto-update on for everyone with `"autoUpdate": true` on the marketplace's
entry in `extraKnownMarketplaces` of its managed settings.

After an update, run `/open-erd:sync` in each workspace (it redraws even when the code did not change): `erd.svg` carries the viewer of the
engine that rendered it.

To uninstall: `/plugin uninstall open-erd@open-erd`, then optionally `/plugin marketplace remove open-erd`
(from a shell: `claude plugin uninstall open-erd@open-erd`). ERD workspaces are not touched.

## Codex

The same seven commands are skills named `open-erd-<command>`. Codex runs one when you type
`$open-erd-init` (or `$open-erd-diff v1.0-handover`, …), or on its own when your request matches the
skill's description.

### From the plugin catalog

```bash
codex plugin marketplace add TOMOSIA-VIETNAM/open-erd
codex plugin add open-erd@open-erd
```

Adding the marketplace only makes the plugin available; `codex plugin add` installs it (or open
`/plugins` in a Codex session and install `open-erd` there). Start a new Codex session, then type
`$open-erd-` to see the commands. `codex plugin list` shows `open-erd@open-erd  installed, enabled`.

To update: `codex plugin marketplace upgrade open-erd`, then start a new session.

Use either this route or the local install below, not both: both put the same `open-erd-*` skills
in front of Codex.

To uninstall: `codex plugin remove open-erd@open-erd`, then optionally
`codex plugin marketplace remove open-erd`. Open a new Codex session afterwards.

### Local install

For when the catalog route is not available to you:

```bash
curl -fsSL https://raw.githubusercontent.com/TOMOSIA-VIETNAM/open-erd/main/install.sh | bash
```

It clones open-erd into `~/.open-erd` and links one skill per command into `~/.agents/skills/`.
The clone holds only what a run needs: the bundled engine (`dist/`), `skills/`, the adapter layer
and the installer.

About piping a script into `bash`:

- the whole script is one function called on its last line, so a download cut short does nothing;
- it installs nothing itself: it clones, then runs `~/.open-erd/scripts/install-local.sh`, which stays
  on disk for you to read;
- it checks out the newest release tag, or `main` while the repository has no release yet. The
  script itself comes from `main`; the tag pins only the clone it leaves behind;
- it refuses to touch `~/.open-erd` when that is not a clone of this repository, and refuses to
  overwrite a skill directory it did not create.

Already have a clone? Run its installer directly:

```bash
./scripts/install-local.sh            # links ~/.agents/skills/open-erd-* into this clone
./scripts/install-local.sh --copy     # copies instead, for an agent that will not follow symlinks
```

Environment for the one-liner: `OPEN_ERD_HOME` (default `~/.open-erd`), `OPEN_ERD_REF` (a branch or
tag), `OPEN_ERD_REPO` (a fork).

### Update

Run the one-liner again; it moves the clone to the newest release and relinks. With your own clone,
`git pull` is enough: the skills are links into it.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/TOMOSIA-VIETNAM/open-erd/main/install.sh | bash -s -- --uninstall
```

Removes the `~/.agents/skills/open-erd-*` entries it created, then `~/.open-erd`. Anything with the
same name that it did not create is reported and kept. With your own clone:
`./scripts/install-local.sh --uninstall`.

### How the skills find open-erd

Each Codex skill is a few lines: read `adapters/root.md`, find the open-erd directory, then follow
`skills/<command>/SKILL.md`, the same file Claude Code runs. `adapters/root.md` also maps the
Claude Code tool names used in those files to their Codex equivalents. Where the agent has no
subagent tool, the checks that init, sync and review hand to a second agent run as a separate pass
by the same agent, which tells you so.

---

[Usage](./USAGE.md) · [Development](./DEVELOPMENT.md)
