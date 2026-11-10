# Shepherd

Shepherd is an executive assistant and manager for day to day work, built as an agent package on [Troupe](https://github.com/ag0os/troupe). It runs in any directory, manages terminal sessions and other coding agents, and keeps its state in the launch directory. What it does and how to use it: [docs/SHEPHERD.md](docs/SHEPHERD.md).

## Install

Bun 1.2.22, Git and `jq` first, then:

```sh
bun install --frozen-lockfile
bun run compile shepherd
bin/shepherd --version
```

Put `bin/` on PATH and keep `packages/` beside it. The full machine setup is [docs/SETUP.md](docs/SETUP.md).

## Where things are

- `agents/shepherd.md` and `agents/shepherd.ts`: the declaration and its extension. Further agents would sit beside them under `agents/`, each with its own roster entry.
- `system-prompts/shepherd/`: the prompt text. `lib/shepherd/`: the tool and record code. `packages/software/`: the software coordination module ([docs/PACKAGES.md](docs/PACKAGES.md)).
- `scripts/`: the build definition, the source identity (`shepherd-source-v2.ts`), the resolution guard, the pin digest and the installation proof.
- `evals/shepherd/`: the on demand evals ([docs/SHEPHERD-EVALS.md](docs/SHEPHERD-EVALS.md)).
- `troupe-pin.json`: the Troupe tag, commit and framework digest this package is built against ([docs/STAMPS.md](docs/STAMPS.md)).
