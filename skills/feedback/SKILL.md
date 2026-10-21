---
name: feedback
description: Send feedback or a bug report about the open-erd plugin itself as a GitHub issue on TOMOSIA-VIETNAM/open-erd, using the user's own gh login, after showing the exact draft and getting confirmation. Never attaches the user's model, table names, paths or project data. Use when the user types /open-erd:feedback, says open-erd did something wrong, or wants it to work differently.
---

# feedback

Creates one issue on `TOMOSIA-VIETNAM/open-erd`. These hold for every run:

- **Fixed destination**: `TOMOSIA-VIETNAM/open-erd`. Nothing is written in the
  workspace or any source repo.
- **Public and permanent**: nothing is sent until the user has seen the exact
  title and body and said yes.
- **The problem, never the project**: no model content, table, column or
  domain names, file paths, repo names, hostnames, SQL, evidence strings or
  screenshots of the ERD go in automatically. Engine messages usually contain
  them: describe the error in generic words ("validate rejected a relation
  whose target table id had 4 segments") instead of pasting. If the user wants
  to attach something, they add it themselves after reading the draft.

## 1. Content

Use the text after `/open-erd:feedback`. Empty, and the conversation does not
make the problem clear → ask one question: what should be different, and what
happened. Do not read the workspace or source to enrich it.

## 2. Facts to include

```bash
node -p "require('<plugin root>/.claude-plugin/plugin.json').version"
node <plugin root>/dist/open-erd.mjs --version 2>/dev/null || node -p "require('<plugin root>/engine/package.json').version"
node --version
uname -sr        # Windows: ver
```

`<plugin root>`: `${CLAUDE_PLUGIN_ROOT}`, or two levels above this skill's base
directory when that is empty. A
value that cannot be read → `unknown`. Last command: the last
`/open-erd:<name>` run in this conversation and whether it succeeded, else
`none`.

## 3. Draft

English, whatever language the user wrote in (translate faithfully, keep the
user's original below it when not English). Title under 70 characters, naming
the problem. Body:

```markdown
### Feedback
<user's text, cleaned of project identifiers>

### Environment
- open-erd plugin: <version>
- engine: <version>
- Node: <version>
- OS: <name and release>
- Last command: /open-erd:<name> (<succeeded|failed: generic description>)
```

## 4. Confirm

Print the title and body verbatim and ask: create it / edit first / cancel.
Only "create" sends. Edits → redraft and ask again.

## 5. Send

Write the body to `${TMPDIR:-/tmp}/open-erd-feedback.md`, then:

```bash
gh auth status --hostname github.com
gh issue create --repo TOMOSIA-VIETNAM/open-erd --title "<title>" --body-file "${TMPDIR:-/tmp}/open-erd-feedback.md"
```

`gh` missing, not logged in, or the command fails → print
`https://github.com/TOMOSIA-VIETNAM/open-erd/issues/new` on its own line,
then the title and body, and say the issue does not exist until the user
submits it there. Never try another repository or account.

## 6. Report

Created: the issue URL `gh` printed, on its own line. Otherwise: what the user
needs to do. Either way, say that nothing from their project was sent.
