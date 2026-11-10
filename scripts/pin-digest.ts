#!/usr/bin/env bun
/**
 * The pin record's framework digest, derived from a Troupe commit's Git
 * tree rather than from an install: the blobs of exactly the members the
 * framework origin selects (`isFrameworkPath`), framed as the installed
 * check frames them (`troupe-agent-origin-v2`, executable status framed and
 * always 0, since the framework origin names no runtime tools). Run it
 * against any clone holding the tag and compare with the installed digest
 * before committing a pin.
 *
 * Usage:
 *   bun scripts/pin-digest.ts <git-dir> <commit> [--json]
 */

import {
	createGitRunner,
	framedDigest,
	type GitRunner,
	type SourceFile,
} from "troupe/provenance";
import { isFrameworkPath } from "./shepherd-source-v2";

/** The domain of one origin's own digest in `troupe/provenance`. */
export const ORIGIN_DOMAIN = "troupe-agent-origin-v2";

function run(git: GitRunner, args: string[], cwd: string): Uint8Array {
	const result = git(args, cwd);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/** The framework members at `commit` and their digest, read from Git objects only. */
export function treeDigest(
	gitDir: string,
	commit: string,
	git: GitRunner = createGitRunner(),
): { commit: string; digest: string; paths: string[] } {
	const full = new TextDecoder()
		.decode(run(git, ["rev-parse", "--verify", `${commit}^{commit}`], gitDir))
		.trim();
	const listing = new TextDecoder().decode(
		run(git, ["ls-tree", "-r", "-z", "--full-tree", full], gitDir),
	);
	const files: SourceFile[] = [];
	for (const record of listing.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode = "", type = "", id = ""] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (!isFrameworkPath(path)) continue;
		if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
			throw new Error(
				`${path}: a member must be a regular file (mode ${mode})`,
			);
		}
		files.push({
			path,
			content: run(git, ["cat-file", "blob", id], gitDir),
			executable: false,
		});
	}
	return {
		commit: full,
		digest: `sha256:${framedDigest(ORIGIN_DOMAIN, files, { modes: true })}`,
		paths: files.map((file) => file.path).sort(),
	};
}

if (import.meta.main) {
	const [gitDir, commit] = process.argv.slice(2);
	if (!gitDir || !commit) {
		console.error(
			"Usage: bun scripts/pin-digest.ts <git-dir> <commit> [--json]",
		);
		process.exit(1);
	}
	const result = treeDigest(gitDir, commit);
	console.log(
		process.argv.includes("--json")
			? JSON.stringify(result, null, "\t")
			: `${result.commit} ${result.digest} (${result.paths.length} members)`,
	);
}
