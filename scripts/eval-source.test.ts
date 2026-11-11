import { afterAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGatedPath } from "../evals/shepherd/gated-paths";
import { EVALUATION_MODULES } from "../evals/shepherd/identity";
import { result } from "../evals/shepherd/testing";
import { ALWAYS_GATED, verifyResults } from "../evals/shepherd/verify";
import {
	type BuildProvenance,
	compileAgent,
	GATED_MODULES,
	gitStamp,
	IDENTITY_MODULE,
	isSourcePath,
	readWorktreeSource,
	versionLine,
} from "./eval-source";
import { initShepherdRepo, testGit, writeAt } from "./eval-source-fixture";
import { PACKAGE_ROOT, troupeRoot } from "./shepherd-definition";
import {
	EVAL_SEAM,
	evaluationInputs,
	PinError,
	readPin,
} from "./shepherd-source-v2";

// The eval seam is an evaluation input: v2's source membership does not
// select it, so the seam names it among the always gated modules.
describe("the package eval gate covers its build seam", () => {
	test("the identity module and the seam are gated under every policy", () => {
		expect([...GATED_MODULES].sort()).toEqual(
			[IDENTITY_MODULE, "scripts/eval-source.ts"].sort(),
		);
		for (const path of GATED_MODULES) {
			expect([path, isGatedPath(path)]).toEqual([path, true]);
			expect([path, ALWAYS_GATED.includes(path)]).toEqual([path, true]);
		}
	});

	test("the evaluation identity hashes the seam, as v2's evaluation inputs select it", () => {
		expect(isSourcePath(EVAL_SEAM)).toBe(false);
		expect(EVALUATION_MODULES).toEqual([EVAL_SEAM]);
		expect(evaluationInputs(PACKAGE_ROOT).files).toEqual([
			...EVALUATION_MODULES,
		]);
	});
});

// A3: the version line's framework part is the lockfile of the package the
// build was captured from, and the verifier reads the checked-out package's.
describe("the eval version line follows the captured package", () => {
	const scratch = realpathSync(
		mkdtempSync(join(tmpdir(), "shepherd-eval-version-")),
	);
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const EVALS = join(PACKAGE_ROOT, "evals/shepherd");

	function fixture(name: string, troupe: string): string {
		const root = join(scratch, name);
		mkdirSync(root);
		initShepherdRepo(root, {
			// The fixture's default ignores itself, leaving the package dirty.
			".gitignore": "bin/\n",
			"package.json": `${JSON.stringify({ dependencies: { troupe } })}\n`,
			"bun.lock": `{\n  "lockfileVersion": 1,\n  "packages": {\n    "troupe": ["troupe@${troupe}", {}],\n  },\n}\n`,
			"evals/shepherd/rubric.json": readFileSync(
				join(EVALS, "rubric.json"),
				"utf8",
			),
			"evals/shepherd/policy.json": readFileSync(
				join(EVALS, "policy.json"),
				"utf8",
			),
		});
		return root;
	}

	/** The line a build of `root` prints, read from the entry the compiler generated. */
	async function builtLine(root: string): Promise<string> {
		let line = "";
		await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile: join(scratch, `${root.split("/").at(-1)}-shepherd`),
			stamp: gitStamp(testGit),
			build: async (request) => {
				writeFileSync(request.outFile, "");
				const entry = readFileSync(request.entry, "utf8");
				line =
					entry.match(/shepherd troupe-agent-source-v2 [^"\\\n]+/)?.[0] ?? "";
			},
		});
		return line;
	}

	/** Problems verify reports about version output for a result recording `version`. */
	function versionProblems(root: string, version: string): string[] {
		const source = readWorktreeSource(root, { git: testGit });
		const value = result();
		value.source = { hash: source.source, manifest: source.entries };
		const build = value.evaluation.invocations[0]?.build;
		if (!build) throw new Error("the handmade result has no build");
		build.revision = git(root);
		build.dirty = false;
		build.sourceDirty = false;
		build.version = `${version}\n`;
		writeAt(
			root,
			`evals/shepherd/results/${source.source.slice(7)}.json`,
			`${JSON.stringify(value, null, "\t")}\n`,
		);
		return verifyResults(root, { git: testGit }).problems.filter((problem) =>
			problem.includes("version output"),
		);
	}

	const git = (root: string) =>
		new TextDecoder()
			.decode(testGit(["rev-parse", "HEAD"], root).stdout)
			.trim();

	test("two packages with different troupe resolutions each get their own line", async () => {
		const lines: Record<string, string> = {};
		for (const [name, troupe] of [
			["alpha", "file:../alpha-troupe"],
			["beta", "file:../beta-troupe"],
		] as const) {
			const root = fixture(name, troupe);
			const source = readWorktreeSource(root, { git: testGit }).source;
			const expected = `shepherd troupe-agent-source-v2 framework/troupe=${troupe}+local package/shepherd=${git(root)} source=${source}`;
			expect([name, await builtLine(root)]).toEqual([name, expected]);
			expect([name, versionProblems(root, expected)]).toEqual([name, []]);
			lines[name] = expected;
		}
		// Each verifier reads its own package's lock: the other's line is refused.
		const alpha = join(scratch, "alpha");
		const swapped = (lines.alpha ?? "").replace("alpha-troupe", "beta-troupe");
		expect(versionProblems(alpha, swapped)).toHaveLength(1);
	});
});

// C24 through the eval seam: the build and the verifier consume the same
// verified framework facts (pin, request, lockfile, installed bytes), so
// their lines agree, and a change to the bytes or the pin moves both.
describe("eval builds and the verifier use the verified framework facts (C24)", () => {
	const scratch = realpathSync(
		mkdtempSync(join(tmpdir(), "shepherd-eval-pin-")),
	);
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const EVALS = join(PACKAGE_ROOT, "evals/shepherd");
	const PIN = readPin(PACKAGE_ROOT);
	if (!PIN) throw new Error("this package has no pin record");
	const COMMIT = PIN.commit;
	const REQUEST = `git+https://github.com/ag0os/troupe.git#${COMMIT}`;
	/** Verbatim from this package's bun.lock. */
	const TARBALL = `["troupe@github:ag0os/troupe#${COMMIT.slice(0, 7)}", { "dependencies": { "typescript": "^5.6.2", "yaml": "^2", "zod": "^4" } }, "ag0os-troupe-${COMMIT.slice(0, 7)}"]`;
	/** Derived from spike S-2's true Git tuple, re-pointed at the tag commit. */
	const GIT = `["troupe@git+ssh://git@github.com/ag0os/troupe.git#${COMMIT}", { "dependencies": { "typescript": "^5.6.2", "yaml": "^2", "zod": "^4" } }, "${COMMIT}"]`;
	const MEMBERS = [
		"package.json",
		"lib/index.ts",
		"lib/text-imports.d.ts",
		"lib/agent-format",
		"lib/entries",
	];

	test("the tarball fixture is this package's lock entry", () => {
		expect(readFileSync(join(PACKAGE_ROOT, "bun.lock"), "utf8")).toContain(
			`    "troupe": ${TARBALL},\n`,
		);
	});

	/** A committed package with its own installed copy of this package's Troupe. */
	function fixture(
		name: string,
		options: { lock: string; pin?: string },
	): string {
		const root = join(scratch, name);
		mkdirSync(root);
		initShepherdRepo(root, {
			".gitignore": "bin/\nnode_modules/\n",
			"package.json": `${JSON.stringify({ dependencies: { troupe: REQUEST } })}\n`,
			"bun.lock": `{\n  "lockfileVersion": 1,\n  "packages": {\n    "troupe": ${options.lock},\n  },\n}\n`,
			...(options.pin === undefined ? {} : { "troupe-pin.json": options.pin }),
			"evals/shepherd/rubric.json": readFileSync(
				join(EVALS, "rubric.json"),
				"utf8",
			),
			"evals/shepherd/policy.json": readFileSync(
				join(EVALS, "policy.json"),
				"utf8",
			),
		});
		const installed = troupeRoot(PACKAGE_ROOT);
		for (const member of MEMBERS) {
			cpSync(
				join(installed, member),
				join(root, "node_modules/troupe", member),
				{
					recursive: true,
				},
			);
		}
		expect(troupeRoot(root)).toBe(join(root, "node_modules/troupe"));
		return root;
	}

	const pinText = (overrides: Record<string, unknown> = {}) =>
		`${JSON.stringify({ ...PIN, ...overrides }, null, "\t")}\n`;

	async function build(root: string) {
		let line = "";
		const agent = await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile: join(scratch, `${root.split("/").at(-1)}-shepherd`),
			stamp: gitStamp(testGit),
			build: async (request) => {
				writeFileSync(request.outFile, "");
				const entry = readFileSync(request.entry, "utf8");
				line =
					entry.match(/shepherd troupe-agent-source-v2 [^"\\\n]+/)?.[0] ?? "";
			},
		});
		return { line, provenance: agent.provenance };
	}

	/** The line the verifier rebuilds for a recorded build of `root`. */
	function verifierLine(root: string): string {
		const source = readWorktreeSource(root, { git: testGit });
		return versionLine({
			revision: git(root),
			dirty: false,
			sourceDirty: false,
			manifest: { source: source.source, entries: [] },
			packageRoot: root,
		});
	}

	const git = (root: string) =>
		new TextDecoder()
			.decode(testGit(["rev-parse", "HEAD"], root).stdout)
			.trim();
	const frameworkPart = (line: string) => line.split(" ")[2];

	for (const [lock, tuple] of [
		["tarball", TARBALL],
		["true Git", GIT],
	] as const) {
		test(`the ${lock} lock with an agreeing pin: unmarked in the build and the verifier`, async () => {
			const root = fixture(`agree-${lock.replace(" ", "-")}`, {
				lock: tuple,
				pin: pinText(),
			});
			const built = await build(root);
			expect(frameworkPart(built.line)).toBe(`framework/troupe=${COMMIT}`);
			expect(built.provenance?.framework).toEqual({
				revision: COMMIT,
				marker: null,
			});
			expect(versionLine(built.provenance as BuildProvenance)).toBe(built.line);
			expect(verifierLine(root)).toBe(built.line);
		});
	}

	test("changed framework bytes: the verifier no longer matches, a new build is dirty", async () => {
		const root = fixture("bytes", { lock: TARBALL, pin: pinText() });
		const before = await build(root);
		appendFileSync(
			join(root, "node_modules/troupe/lib/agent-format/compiler.ts"),
			"// changed\n",
		);
		const after = await build(root);
		expect(frameworkPart(after.line)).toBe(`framework/troupe=${COMMIT}+dirty`);
		expect(verifierLine(root)).toBe(after.line);
		expect(verifierLine(root)).not.toBe(before.line);
	});

	test("a missing pin is local in both", async () => {
		for (const [name, tuple, revision] of [
			["none-tarball", TARBALL, "unknown"],
			["none-git", GIT, COMMIT],
		] as const) {
			const root = fixture(name, { lock: tuple });
			const built = await build(root);
			expect([name, frameworkPart(built.line)]).toEqual([
				name,
				`framework/troupe=${revision}+local`,
			]);
			expect([name, verifierLine(root)]).toEqual([name, built.line]);
		}
	});

	test("a mismatched pin is local, or dirty for a mismatched digest, in both", async () => {
		for (const [name, overrides, part] of [
			["commit", { commit: "0".repeat(40) }, "framework/troupe=unknown+local"],
			["owner", { owner: "someone" }, "framework/troupe=unknown+local"],
			[
				"digest",
				{ digest: `sha256:${"0".repeat(64)}` },
				`framework/troupe=${COMMIT}+dirty`,
			],
		] as const) {
			const root = fixture(`mismatch-${name}`, {
				lock: TARBALL,
				pin: pinText(overrides),
			});
			const built = await build(root);
			expect([name, frameworkPart(built.line)]).toEqual([name, part]);
			expect([name, verifierLine(root)]).toEqual([name, built.line]);
		}
	});

	test("a malformed pin is refused by the build and the verifier", async () => {
		const root = fixture("malformed", {
			lock: TARBALL,
			pin: pinText({ commit: COMMIT.slice(0, 7) }),
		});
		await expect(build(root)).rejects.toThrow("troupe-pin.json");
		expect(() => verifierLine(root)).toThrow(PinError);
	});
});

// Obligation: a clean provenance needs two agreeing reads. Bun 1.2.22's
// spawnSync can drop piped stdout under load and report exit 0, and an empty
// `git status --porcelain` would otherwise stamp a dirty build clean.
describe("a clean provenance needs two agreeing status reads", () => {
	const scratch = realpathSync(
		mkdtempSync(join(tmpdir(), "shepherd-eval-status-")),
	);
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	function fixture(name: string): string {
		const root = join(scratch, name);
		mkdirSync(root);
		initShepherdRepo(root, { ".gitignore": "bin/\n" });
		return root;
	}

	/** testGit, except that the first `status` prints nothing. */
	function losingStatus() {
		const seen = { reads: 0 };
		const git: typeof testGit = (args, cwd, input) => {
			if (args[0] === "status") {
				seen.reads += 1;
				if (seen.reads === 1)
					return { code: 0, stdout: new Uint8Array(), stderr: "" };
			}
			return testGit(args, cwd, input);
		};
		return { git, seen };
	}

	test("a lost status read does not stamp a dirty repository clean", async () => {
		const root = fixture("dirty");
		writeAt(root, "notes/todo.txt", "later\n");
		const { git, seen } = losingStatus();
		expect(await gitStamp(git).capture(root)).toMatchObject({
			dirty: true,
			sourceDirty: false,
		});
		expect(seen.reads).toBe(2);
	});

	test("a clean repository reads clean twice", async () => {
		const root = fixture("clean");
		const { git, seen } = losingStatus();
		expect((await gitStamp(git).capture(root)).dirty).toBe(false);
		expect(seen.reads).toBe(2);
	});

	test("a status read that lists changes is believed at once", async () => {
		const root = fixture("listed");
		writeAt(root, "notes/todo.txt", "later\n");
		let reads = 0;
		const git: typeof testGit = (args, cwd, input) => {
			if (args[0] === "status") reads += 1;
			return testGit(args, cwd, input);
		};
		expect((await gitStamp(git).capture(root)).dirty).toBe(true);
		expect(reads).toBe(1);
	});
});
