import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./shepherd-definition";

// The documents AGENTS.md names as part of the contract say what the code
// does: STAMPS.md's marker rule, pin keys, digest framing and derivation
// command, SETUP.md's install commands and the proof's usage, and
// AGENTS.md's prerequisites for the checks and what CI runs. Editing one of
// these sentences alone fails here; change it with its test.

const doc = (name: string) =>
	readFileSync(join(PACKAGE_ROOT, "docs", name), "utf8").replace(/\s+/g, " ");
const agents = () =>
	readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8").replace(/\s+/g, " ");
const normal = (text: string) => text.replace(/\s+/g, " ");

test("STAMPS.md states the marker rule, the pin's keys and the digest", () => {
	const stamps = doc("STAMPS.md");
	for (const sentence of [
		"It is the pin's full commit, unmarked, only when all three hold: `package.json` requests that commit from the pin's owner and repository; `bun.lock` names it (the same full commit under a Git resolution, or, under Bun's GitHub tarball resolution `github:<owner>/<repo>#<hex>`, the pin's owner and repository and a hex prefix of at least seven of the pin's commit); and the installed framework members hash to the pin's digest.",
		"Exactly these keys; a proof has exactly `date`, `bun`, `checks` (nonempty) and `evidence`.",
		"`digest` is the framework origin's own digest, the one the stamp's provenance records for `framework/troupe`: SHA-256, as `sha256:<hex>`, of `UTF8(\"troupe-agent-origin-v2\\0\")` followed by each selected member in unsigned UTF-8 path order, framed as a big-endian uint64 path length, the path bytes, one executable status byte (always 0, since the framework origin names no runtime tools), a big-endian uint64 content length and the raw content.",
		"bun scripts/pin-digest.ts <a clone holding the tag> <tag> --json",
	])
		expect(stamps).toContain(normal(sentence));
});

test("SETUP.md states the install commands and the proof's usage", () => {
	const setup = doc("SETUP.md");
	for (const sentence of [
		"run `bun install --frozen-lockfile`, then `bun run compile shepherd`.",
		"bun scripts/prove-installation.ts --commit <full commit> --parent <empty directory> --evidence <evidence directory> --avoid <root> [--avoid <root>]...",
	])
		expect(setup).toContain(normal(sentence));
});

test("AGENTS.md states what the checks need and what CI runs", () => {
	const text = agents();
	expect(text).toContain(
		normal(
			"It needs Bun 1.2.22, Git and Python 3.10 or later on PATH (several eval tests run `python3`); zsh is optional, and without it the Python harness check expects one more skipped case (`evals/shepherd/harness.test.ts`).",
		),
	);
	expect(text).toContain(
		"the resolution guard (`bun --no-install scripts/resolution.ts`)",
	);
	const ci = readFileSync(
		join(PACKAGE_ROOT, ".github/workflows/ci.yml"),
		"utf8",
	);
	for (const command of [
		"bun install --frozen-lockfile",
		"bun --no-install scripts/resolution.ts",
		"bun run checks",
		"bun run compile shepherd",
		"bin/shepherd --version",
	])
		expect(ci).toContain(command);
});
