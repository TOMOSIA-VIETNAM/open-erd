# ROOT + tool names — for every platform except Claude Code

Claude Code never reads this file: it sets `${CLAUDE_PLUGIN_ROOT}` itself and loads `skills/<cmd>/`
directly. Every other platform enters through a short skill under `.agents/skills/open-erd-<cmd>/`,
reads this file FIRST, resolves `ROOT`, then follows `ROOT/skills/<cmd>/SKILL.md` verbatim.

This file is the ONLY place that names a platform. FORBIDDEN here: any step of a command, any engine
call, any model field or approval rule. Those live under `ROOT/skills/` and have exactly one owner.

## 1 — ROOT

`ROOT` ≡ the directory holding both `dist/open-erd.mjs` and `skills/_shared/rules.md` (the root of
the open-erd repository). In ANY file below `ROOT`, `${CLAUDE_PLUGIN_ROOT}` and `<plugin root>` ≡
`ROOT`, and "this skill's base directory" ≡ `ROOT/skills/<cmd>/`.

Resolve with the first method that hits:

| # | when | how |
|---|---|---|
| 1 | whatever sent you here states `ROOT:` + an absolute path | use it verbatim |
| 2 | you know the absolute path of this file or of the skill that sent you here | resolve symlinks first (a skill is usually a link into the clone): `cd -P "<that file's directory>" && pwd -P`, then walk up its ancestors → first directory containing `dist/open-erd.mjs` and `skills/_shared/rules.md` is `ROOT` |
| 3 | else | shell: `for d in ~/.open-erd ~/.agents/skills/open-erd-*/../../..; do [ -f "$d/dist/open-erd.mjs" ] && [ -f "$d/skills/_shared/rules.md" ] && (cd -P "$d" && pwd -P); done \| sort -u` — `cd -P`, because a plain `cd` resolves `..` before following the skill's symlink and lands in your home directory |

| hits | do |
|---|---|
| 1 | proceed; check it with `node ROOT/dist/open-erd.mjs --help` |
| 0 | STOP. Say open-erd is not installed and point at `docs/install.md` in the open-erd repository. FORBIDDEN: guessing a path, or working from memory of what these commands do |
| ≥2 | ask the user which one, WAIT for the answer |

Method 3's list and the target directory in `scripts/install-local.sh` are the same set seen from two
sides; `engine/test/platform-layer.test.js` fails when one gains a path the other lacks.

## 2 — Tool and command names

Files below `ROOT` name Claude Code's tools and commands. What binds is the CAPABILITY, not the name:

| file says | use | none available ⇒ |
|---|---|---|
| `Read`, "open the file" | your file-read tool | `cat` / `sed -n` via shell |
| `Write`, `Edit` | your file-write / patch tool | shell heredoc — FORBIDDEN on a file you have not read in full |
| a shell command | your shell tool | — |
| a question to the user, "ask", "wait" | ask in chat: one message, every option + your recommendation, then WAIT | FORBIDDEN: deciding for the user, or continuing unanswered |
| a subagent / Claude Code `Agent` tool with a fresh context | your subagent tool, started without this conversation | do the step yourself as a separate pass: re-read ONLY the inputs that step hands the subagent (for the verifier: `ROOT/skills/_shared/verifier.md` and the fact list), not your diff or your earlier reasoning; produce the same output the subagent would, and still write every file the step writes. Tell the user once that the second reader ran without a separate agent |
| `/open-erd:<cmd>` (to run, or to suggest to the user) | the skill `open-erd-<cmd>`; on Codex write it `$open-erd-<cmd>` | — |

A tool you lack NEVER turns a step into one you may skip: substitute the capability, or STOP and say
which step you cannot perform.

## 3 — Platform notes

| platform | note |
|---|---|
| all | `node` ≥ 20.10 and `git` on PATH; `gh` logged in for the commands that use GitHub |
| Codex | no structured question tool outside Plan mode, so the question row in "Tool and command names" applies |
