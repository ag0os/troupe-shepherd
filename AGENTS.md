# Working in this repository

Shepherd as an agent package on Troupe. Read [README.md](README.md) for the layout.

## The checks

One command, the same for you and for CI:

```sh
bun run checks
```

It runs typecheck, Biome and the full suite. It needs Bun 1.2.22, Git and Python 3.10 or later on PATH (several eval tests run `python3`); zsh is optional, and without it the Python harness check expects one more skipped case (`evals/shepherd/harness.test.ts`). A change is done when it passes on the exact head. The suite takes several minutes; `bun test ./path` runs one file (`bun test` takes a substring filter, so give root paths a leading `./`). CI also runs `bun install --frozen-lockfile`, the resolution guard (`bun --no-install scripts/resolution.ts`), `bun run compile shepherd` and `bin/shepherd --version`, and fails unless both origins print unmarked. The Husky pre-commit hook runs `bun run check:all`.

## The contract

There is no `docs/contracts/`. The obligations are the tests, each with a comment naming what it holds, and the documents they pin: [docs/STAMPS.md](docs/STAMPS.md) for the version line, the pin record and source identity, [docs/SETUP.md](docs/SETUP.md) for installation and its proof, [docs/PACKAGES.md](docs/PACKAGES.md) for packages. A change to an obligation changes its sentence and its test together; a test that pins old behavior is rewritten as the new obligation, not deleted.

## Rules

- Bun stays 1.2.22: the compiled binary embeds the runtime, and a new Bun may change the lock shape the pin rule reads. `zod` and `typescript` stay exact pins, because Troupe's imports resolve from this package's `node_modules`.
- Troupe is pinned in three places that must agree: the commit in `package.json`, the lock, and `troupe-pin.json`. Move all three together ([docs/STAMPS.md](docs/STAMPS.md), "To move the pin"). `troupe` is never a trusted dependency.
- Keep Shepherd's files in their per agent places (`agents/`, `lib/shepherd/`, `system-prompts/shepherd/`).
- Tests touch fixtures and scratch directories only, never a real workspace or a real HOME.
- No em or en dashes in docs or comments.
