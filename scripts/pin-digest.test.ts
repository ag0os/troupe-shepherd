import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceInputs } from "troupe/provenance";
import { git, writeAt } from "./eval-source-fixture";
import { treeDigest } from "./pin-digest";
import { v2Inputs } from "./shepherd-source-v2";

// The pin digest derived from a commit's Git objects equals the framework
// origin's digest of the same commit checked out, so a pin can be written
// from the tag's tree and compared with an install.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pin-digest-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function troupeFixture(name: string): string {
	const root = join(scratch, name);
	for (const [path, text] of Object.entries({
		"package.json": '{"name":"troupe"}\n',
		"lib/index.ts": "export {};\n",
		"lib/text-imports.d.ts": "declare module '*.md';\n",
		"lib/agent-format/compiler.ts": "export const compile = 1;\n",
		"lib/agent-format/adapters/claude.ts": "export const claude = 1;\n",
		"lib/agent-format/compiler.test.ts": "test\n",
		"lib/agent-format/__fixtures__/a.md": "fixture\n",
		"lib/entries/cli.ts": "export const cli = 1;\n",
		"lib/shepherd/tool.ts": "export const tool = 1;\n",
		"scripts/compile.ts": "compile\n",
		"agents/shepherd.md": "agent\n",
	})) {
		writeAt(root, path, text);
	}
	git(root, "init", "-q", "-b", "main");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "fixture");
	return root;
}

const installedDigest = (root: string) => {
	const [framework] = v2Inputs({ packageRoot: scratch, troupeRoot: root });
	if (!framework) throw new Error("no framework origin");
	return readSourceInputs(framework).provenance.digest;
};

describe("the pin digest from a Git tree", () => {
	test("equals the installed check's digest of the same members", () => {
		const root = troupeFixture("same");
		const derived = treeDigest(root, "HEAD");
		expect(derived.digest).toBe(installedDigest(root));
		expect(derived.paths).toEqual([
			"lib/agent-format/adapters/claude.ts",
			"lib/agent-format/compiler.ts",
			"lib/entries/cli.ts",
			"lib/index.ts",
			"lib/text-imports.d.ts",
			"package.json",
		]);
	});

	test("reads the commit, not the work tree", () => {
		const root = troupeFixture("worktree");
		const before = treeDigest(root, "HEAD").digest;
		writeAt(root, "lib/agent-format/compiler.ts", "uncommitted\n");
		expect(treeDigest(root, "HEAD").digest).toBe(before);
		expect(installedDigest(root)).not.toBe(before);
	});

	test("refuses a member that is a symlink", () => {
		const root = troupeFixture("link");
		unlinkSync(join(root, "lib/entries/cli.ts"));
		symlinkSync("../index.ts", join(root, "lib/entries/cli.ts"));
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "link");
		expect(() => treeDigest(root, "HEAD")).toThrow(
			"lib/entries/cli.ts: a member must be a regular file",
		);
	});
});
