import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	avoidedPathEntries,
	checkParent,
	denialProfile,
	parseArgs,
} from "./prove-installation";

// The installation proof refuses a parent it cannot trust before cloning.
// Scratch directories only.

const scratch = realpathSync(
	mkdtempSync(join(tmpdir(), "prove-installation-")),
);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function dir(...parts: string[]): string {
	const path = join(scratch, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
}

describe("the proof's parent refusals", () => {
	test("an empty parent outside every checkout is accepted", () => {
		const parent = dir("ok", "parent");
		const ancestors = checkParent(parent, []);
		expect(ancestors[0]).toBe(parent);
		expect(ancestors.at(-1)).toBe("/");
	});

	for (const name of [".git", ".shepherd", "node_modules"]) {
		test(`a ${name} ancestor is refused`, () => {
			const top = dir(`under${name}`);
			mkdirSync(join(top, name));
			const parent = dir(`under${name}`, "a", "parent");
			expect(() => checkParent(parent, [])).toThrow(
				`prohibited ancestor ${join(top, name)}`,
			);
		});
	}

	test("a parent that is itself a checkout is refused", () => {
		const parent = dir("itself");
		mkdirSync(join(parent, ".git"));
		expect(() => checkParent(parent, [])).toThrow("not empty");
	});

	test("a nonempty parent is refused", () => {
		const parent = dir("full");
		writeFileSync(join(parent, "x"), "x\n");
		expect(() => checkParent(parent, [])).toThrow("is not empty");
	});

	test("a missing parent or a file is refused", () => {
		expect(() => checkParent(join(scratch, "absent"), [])).toThrow(
			"does not exist",
		);
		const file = join(dir("file"), "f");
		writeFileSync(file, "f\n");
		expect(() => checkParent(file, [])).toThrow("is not a directory");
	});

	test("a parent within an avoided root is refused", () => {
		const root = dir("avoided");
		const parent = dir("avoided", "inside");
		expect(() => checkParent(parent, [root])).toThrow(
			`within avoided root ${root}`,
		);
	});

	test("an avoided root that does not exist is refused", () => {
		const parent = dir("typo", "parent");
		expect(() => checkParent(parent, [join(scratch, "no-such-root")])).toThrow(
			"does not exist",
		);
	});
});

describe("the proof's denial and inputs", () => {
	test("the profile denies reads of every root and allows the rest", () => {
		const a = dir("deny-a");
		const b = dir("deny-b");
		expect(denialProfile([a, b])).toBe(
			`(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(a)}) (subpath ${JSON.stringify(b)}))`,
		);
	});

	test("PATH entries inside an avoided root are found", () => {
		const root = dir("pathroot");
		const bin = dir("pathroot", "bin");
		const other = dir("elsewhere", "bin");
		expect(avoidedPathEntries(`${other}:${bin}::bin:/usr/bin`, [root])).toEqual(
			[bin],
		);
	});

	test("the commit must be full and the parent and evidence named", () => {
		expect(() =>
			parseArgs(["--commit", "abc", "--parent", "p", "--evidence", "e"]),
		).toThrow("full 40 hex");
		expect(() => parseArgs(["--commit", "a".repeat(40)])).toThrow("required");
		const args = parseArgs([
			"--commit",
			"a".repeat(40),
			"--parent",
			"p",
			"--evidence",
			"e",
			"--avoid",
			"x",
			"--avoid",
			"y",
			"--drop-avoided-path",
		]);
		expect(args.avoid).toEqual(["x", "y"]);
		expect(args.dropAvoidedPath).toBe(true);
	});
});
