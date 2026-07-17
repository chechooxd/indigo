# Contributing to IndigoDB

## Commit convention

This monorepo uses [**Conventional Commits**](https://www.conventionalcommits.org)
with a **package scope**. The scope tells you which part of the monorepo a change
touches, which keeps history readable and makes per-package changelogs possible.

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Types

| Type       | When to use                                                        |
| ---------- | ------------------------------------------------------------------ |
| `feat`     | A new feature for a package                                         |
| `fix`      | A bug fix                                                           |
| `refactor` | A code change that neither fixes a bug nor adds a feature          |
| `perf`     | A performance improvement                                          |
| `docs`     | Documentation only                                                 |
| `test`     | Adding or fixing tests                                             |
| `build`    | Build system, compiler, or bundler changes                        |
| `chore`    | Tooling, config, or housekeeping (no src behaviour change)         |
| `ci`       | CI configuration                                                   |

### Scopes

Use the package name **without** the `@indigodb/` prefix:

`ast` · `parser` · `core` · `migrator` · `generator` · `client` · `cli` · `studio`

Plus these non-package scopes:

- `repo` — root tooling (Turborepo, pnpm workspace, tsconfig, .gitignore)
- `deps` — dependency bumps

A change spanning packages may list multiple scopes: `feat(core,cli): ...`.
Prefer splitting cross-cutting work into one commit per package when practical —
`@indigodb/core`'s `ResolvedSchema` is the shared contract, so a change there
often lands first, followed by its consumers.

### Subject

Imperative mood, lowercase, no trailing period: "add", not "added"/"adds".

### Breaking changes

Append `!` after the scope (`feat(core)!: ...`) and/or add a footer:

```
BREAKING CHANGE: resolve() now returns ResolvedSchema instead of Schema
```

### Examples

```
feat(core): resolve @relation into foreign keys and relation metadata
fix(migrator): quote enum defaults with an explicit ::type cast
refactor(client): extract where-clause builder from ModelDelegate
docs(repo): document the db push vs migrate distinction
chore(repo): add turborepo pipeline for build/lint/test
```

## Branching

`main` is the default branch. Do feature work on a branch
(`feat/<scope>-<short-desc>`) and open a PR; don't commit directly to `main`.

## Before you push

```bash
pnpm build   # every package must compile (tsc) and Studio must bundle
pnpm lint    # typecheck-as-lint across the workspace
```
