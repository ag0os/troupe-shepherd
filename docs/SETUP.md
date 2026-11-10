# Shepherd setup

Follow these steps on a fresh machine. Shepherd keeps workspace state on disk; machine settings and logins need their own setup.

1. **Prerequisites.** Install git, `jq` and Bun. On macOS, Homebrew can supply git and `jq`. The status line below needs `jq`; Bun 1.2.22 installs dependencies and builds Shepherd.

2. **Harnesses.** Install Claude Code, the required default backend, and optionally the Codex CLI. Sign in to each harness you intend to use. `codex login` runs per Codex home, so authenticate each home separately.

3. **Herdr, optional.** Install the Herdr binary, then run `herdr integration install claude` and, if using Codex, `herdr integration install codex`. These hooks let panes report agent state. Shepherd also runs without Herdr.

4. **Shepherd.** Clone this repository, enter it, run `bun install --frozen-lockfile`, then `bun run compile shepherd`. The install fetches Troupe from GitHub at the commit `troupe-pin.json` names. Put the repository's `bin/` directory on PATH in your shell configuration so `shepherd` resolves to the binary you built, and keep `packages/` beside `bin/`: the binary reads its base packages from there. `shepherd --version` should print both origins without a marker ([STAMPS.md](STAMPS.md)).

5. **Claude Code settings.** In `~/.claude/settings.json`, or the settings file under `CLAUDE_CONFIG_DIR`, add `"crossSessionInbound": "accept"` for peer messages and this status line for the model and context percentage:

```json
"statusLine": {
  "type": "command",
  "command": "jq -r '\"\\(.model.display_name) \\(.context_window.used_percentage // 0 | floor)%\"'"
}
```

   Merge these properties into the settings object, keeping valid JSON. When launching Shepherds with permissions bypassed, also set `"skipDangerousModePermissionPrompt": true`.

6. **Codex homes.** Keep a home per account. In `~/.config/shepherd/config.json`, or `$XDG_CONFIG_HOME/shepherd/config.json`, configure the `codex` section with `home` or `homeFile`, and optional `model` and `effort`. The full keys are `codex.home` and `codex.homeFile`; the latter names a file whose first non-empty line supplies the home path. See [Shepherd's Tools section](SHEPHERD.md#tools). Log in with the selected home in `CODEX_HOME`. Herdr's Codex integration installs into `~/.codex`; for other homes, link its `hooks.json` and `herdr-agent-state.sh`.

7. **Code host.** Run `gh auth login` for each account you use and set up SSH keys. Follow the [software module's identity check rule](../packages/software/MODULE.md#rules-of-engagement) before writes and before trusting a 404.

8. **Workspaces.** Restore `.shepherd/` directories from backup, or run `shepherd tool init --master` in a root such as `~/shepherds` and `shepherd tool init` in each workspace beneath it. Launch `shepherd` in each and run the init conversation to agree its charter. Claude auto-memory is keyed by absolute path and does not travel with the workspace.

9. **Check.** Run `shepherd tool doctor` and apply the edits it prints by hand. It reads settings without changing them. Then run `shepherd tool check` from the root to check workspace state.

## Independent installation proof

Bun 1.2.22 is the reference version. `scripts/prove-installation.ts` proves that one commit installs and builds on its own:

```sh
bun scripts/prove-installation.ts --commit <full commit> --parent <empty directory> --evidence <evidence directory> --avoid <root> [--avoid <root>]...
```

Before cloning it refuses a parent that is not an empty directory, is inside Git, sits below a Git, `.shepherd` or `node_modules` ancestor, or lies within an avoided root; every avoided root must exist. It clones the commit from this repository (or `--source`) into `<parent>/shepherd`, then, with a scratch HOME, configuration and Bun cache, runs a frozen install, the resolution guard, typecheck, Biome, the full suite (one rerun on the same head if it fails, both logs kept) and `bun run compile shepherd`. It checks that `bin/` holds exactly `shepherd`, that `--version` prints both origins unmarked, that the installed framework matches the pin, that doctor finds the binary on PATH with `packages/` beside it, and that the clone's tracked files still equal the commit. It scans the generated entry and the binary for each avoided root's path. Each avoided root is first read without the denial, a control that must print `READABLE`. Only the clone runs unsandboxed: on macOS every other process, the checkout included, runs under a one line `sandbox-exec` profile denying reads of the avoided roots, shown to bite before anything else runs by a probe of each root that must print `EPERM` or `EACCES`; elsewhere only the control runs and the report records that no denial ran. `--drop-avoided-path` takes PATH entries inside an avoided root out of the consumer environment. The report is `installation.json` in the evidence directory, beside each step's streams.

The resolution guard can also run on its own: `bun --no-install scripts/resolution.ts` checks that Troupe's runtime imports (`typescript`, `yaml`, `zod`) resolve to this package's own `node_modules` at the locked versions under the runtime, `bun test`, `bun build` and `tsc`, with no `NODE_PATH`.

Nested Bun processes, such as the compile script and eval harness children, carry no explicit `--no-install` flag. Bun 1.2.22 auto-installs by default only when it finds no `node_modules` above the importing file, and Troupe is installed inside this package's `node_modules`, so every lookup from it has one. That is a reading of the layout, not a measurement: offline, an undeclared import fails with the same not-found error from inside the installed Troupe and from a directory with no `node_modules` at all, so the probe does not tell the two apart. The resolution guard and the bundled versions are the locked-resolution evidence.
