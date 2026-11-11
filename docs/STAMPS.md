# Shepherd build stamps

How this package stamps Shepherd. The policy is `scripts/shepherd-source-v2.ts`; `scripts/shepherd-source-v2.test.ts` and `scripts/eval-source.test.ts` hold its cases.

## The version line

`shepherd --version` prints one line:

```text
shepherd troupe-agent-source-v2 framework/troupe=<rev>[+local|+dirty] package/shepherd=<rev>[+local|+dirty] source=sha256:<hex>
```

- `source` is the framed SHA-256 under the domain `troupe-agent-source-v2` over both origins. `framework/troupe` is Troupe's library members as installed under `node_modules/troupe`: `package.json`, `lib/index.ts`, `lib/text-imports.d.ts` and the `lib/agent-format/` and `lib/entries/` trees, tests, fixtures and snapshots left out. A Git dependency installs Troupe's whole repository, so nothing outside those members is read. `package/shepherd` is the package's selected files, `troupe-pin.json` among them when present. Executable status of runtime tools is framed too.
- The framework revision comes from the pin record (below). It is the pin's full commit, unmarked, only when all three hold: `package.json` requests that commit from the pin's owner and repository; `bun.lock` names it (the same full commit under a Git resolution, or, under Bun's GitHub tarball resolution `github:<owner>/<repo>#<hex>`, the pin's owner and repository and a hex prefix of at least seven of the pin's commit); and the installed framework members hash to the pin's digest. When the request and the lock agree but the bytes do not, it is the pin's commit marked `+dirty`. With no pin, or when the request or the lock does not name it, it is the lockfile's own revision text (a full commit the lock records, `unknown`, or a folder path) marked `+local`. A pin record that exists but does not parse is refused: the build fails. The digest marks a difference at build time; it does not prevent an install.
- The package revision is the Git `HEAD` of the repository holding the package. It is marked `+dirty` when the selected files (paths, contents, and the executable bit of runtime tools) differ from that commit's tree under the package's prefix, and `+local` (with revision `unknown`) outside Git. Files outside the selection, such as tests under `lib/shepherd/` or `biome.json`, never mark it dirty.

The stamp's provenance JSON carries `marker: "local" | "dirty" | null` for each origin.

## The pin record

`troupe-pin.json` at the repository root names the Troupe this package is built against and the proof behind it:

```json
{
	"tag": "v0.1.1",
	"commit": "<40 hex>",
	"owner": "ag0os",
	"repository": "troupe",
	"digest": "sha256:<64 hex>",
	"proofs": [{ "date": "YYYY-MM-DD", "bun": "1.2.22", "checks": ["..."], "evidence": "..." }]
}
```

Exactly these keys; a proof has exactly `date`, `bun`, `checks` (nonempty) and `evidence`.

`digest` is the framework origin's own digest, the one the stamp's provenance records for `framework/troupe`: SHA-256, as `sha256:<hex>`, of `UTF8("troupe-agent-origin-v2\0")` followed by each selected member in unsigned UTF-8 path order, framed as a big-endian uint64 path length, the path bytes, one executable status byte (always 0, since the framework origin names no runtime tools), a big-endian uint64 content length and the raw content. It is derived from the tag's Git tree, not from an install:

```sh
bun scripts/pin-digest.ts <a clone holding the tag> <tag> --json
```

reads the members' blobs with `git ls-tree` and `git cat-file` and frames them as above. Compare it with the installed digest before committing a pin; a `.gitattributes` with `export-subst` or `export-ignore` in Troupe would make GitHub's tarball bytes differ from the blobs (there is none at `v0.1.1`).

To move the pin: change the commit in `package.json`, run `bun install` with the network, derive the digest from the new tag's tree, write the new record with its proofs, and check that `bun run compile shepherd` prints the framework part unmarked.

## Eval builds and `dirty`

The evals build through `scripts/eval-source.ts`, which keeps the build provenance in the shape the eval results record: `revision` is the package's `HEAD`, `sourceDirty` is the package origin's `dirty` marker, and `dirty` stays repository wide, so any uncommitted change in the repository marks an eval build dirty even when the package's selected bytes are clean. The version line never prints `dirty`. An eval build carries the framework facts its stamp captured; a verifier rebuilding the line from a recorded build's `revision`, `sourceDirty` and source hash computes the same facts (pin, request, lockfile, installed bytes) for the checked-out package, whose equal source hash binds the same install.

v2 manifests do not record whether a file was untracked, so the verifier's note about untracked source entries never appears for package results.
