import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createGitRunner,
	readSourceInputs,
	type SourceInputDefinition,
	SourceInputError,
} from "troupe/provenance";
import { PACKAGE_ROOT, troupeRoot } from "./shepherd-definition";
import {
	dependencyIdentity,
	evaluationInputs,
	FRAMEWORK_ORIGIN,
	frameworkFacts,
	isFrameworkPath,
	isSourcePath,
	lockRevision,
	PinError,
	parsePin,
	readPin,
	readV2Source,
	shepherdStampV2,
	type V2Layout,
	v2Inputs,
} from "./shepherd-source-v2";

// O15: v2 membership is the extracted package's table, read from the
// filesystem by the same predicate `isSourcePath` answers. Fixtures only.

/** The miniature package: a literal list, with no v1 adapter or legacy wrapper. */
const PACKAGE: Record<string, string> = {
	"package.json": JSON.stringify({
		dependencies: { troupe: "file:../dist/troupe" },
	}),
	"bun.lock":
		'{\n  "packages": {\n    "troupe": ["troupe@file:../dist/troupe", {},],\n  },\n}\n',
	"tsconfig.json": "{}\n",
	".gitignore": "node_modules\n",
	"agents/shepherd.md": "declaration\n",
	"agents/shepherd.ts": "extension\n",
	"scripts/build.ts": "build\n",
	"scripts/watch.ts": "watch\n",
	"scripts/shepherd-definition.ts": "definition\n",
	"scripts/shepherd-source-v2.ts": "policy\n",
	"scripts/eval-source.ts": "eval seam\n",
};

/** Table rows: created in the fixture, selected or not. */
const ROWS: [string, boolean, string][] = [
	["package.json", true, "metadata"],
	["bun.lock", true, "lockfile"],
	["tsconfig.json", true, "configuration"],
	[".gitignore", true, "the package's ignore file"],
	["scripts/shepherd-source-v2.ts", true, "policy"],
	["scripts/shepherd-definition.ts", true, "build definition"],
	["scripts/build.ts", true, "build script"],
	["scripts/watch.ts", true, "watcher (C4)"],
	["agents/shepherd.md", true, "declaration"],
	["agents/shepherd.ts", true, "extension"],
	["system-prompts/shepherd/core.md", true, "prompts"],
	["packages/software/MODULE.md", true, "module"],
	["packages/software/tools/publish-check", true, "runtime tool"],
	["packages/software/tests/x.test.ts", true, "software test"],
	["lib/shepherd/compose.ts", true, "library"],
	["lib/shepherd/test-helpers.ts", true, "library helper"],
	["lib/shepherd/compose.test.ts", false, "library test"],
	["lib/shepherd/__fixtures__/a.md", false, "library fixture"],
	["lib/shepherd/__snapshots__/a.snap", false, "library snapshot"],
	["bin/shepherd", false, "output"],
	[
		"extractions/.troupe-dist/troupe/package.json",
		false,
		"outside every selection",
	],
	["evals/shepherd/results/x.json", false, "eval evidence"],
	["evals/shepherd/rubric.yaml", false, "evaluation input (own selector)"],
	["scripts/eval-source.ts", false, "eval build seam (evaluation input)"],
	["packages/software/.DS_Store", false, "host byproduct"],
	["packages/software/node_modules/x.ts", false, "installed module"],
	["packages/software/tools/__pycache__/x.pyc", false, "bytecode"],
	["packages/software/old.pyc", false, "bytecode by name"],
	[
		"packages/software/cache.pyc/helper.ts",
		false,
		"beneath a bytecode-named directory (C23)",
	],
	["packages/software/x.pyc.ts", true, "a suffix only in the middle"],
	["scripts/shepherd-source.ts", false, "v1 adapter"],
	["scripts/watch-agents.ts", false, "legacy watcher"],
	["scripts/agent-compiler.ts", false, "legacy wrapper"],
	["agents/webfetch.md", false, "other agent"],
];

let dir: string;
let layout: V2Layout;

function put(path: string, text: string) {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const context = () => ({
	agentId: "shepherd",
	consumerRoot: layout.packageRoot,
	declarationRoot: join(layout.packageRoot, "agents"),
	outDir: join(layout.packageRoot, "bin"),
});

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-v2-")));
	layout = {
		packageRoot: join(dir, "package"),
		troupeRoot: join(dir, "dist/troupe"),
	};
	for (const [path, text] of Object.entries(PACKAGE)) {
		put(`package/${path}`, text);
	}
	for (const [path] of ROWS) {
		if (!(path in PACKAGE)) put(`package/${path}`, `${path}\n`);
	}
	chmodSync(join(dir, "package/packages/software/tools/publish-check"), 0o755);
	put("dist/troupe/package.json", "{}\n");
	put("dist/troupe/lib/agent-format/compiler.ts", "compiler\n");
	put("dist/troupe/lib/index.ts", "index\n");
	put("dist/troupe/lib/text-imports.d.ts", "types\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("package-relative membership table (O15)", () => {
	test("capture succeeds on the miniature package", async () => {
		const captured = await shepherdStampV2(layout).capture(context());
		expect(captured.manifest.source).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("capture succeeds with no v1 adapter or legacy wrapper present (R1)", async () => {
		const legacy = [
			"scripts/shepherd-source.ts",
			"scripts/watch-agents.ts",
			"scripts/agent-compiler.ts",
		];
		for (const path of legacy) rmSync(join(layout.packageRoot, path));
		for (const path of legacy) {
			expect(existsSync(join(layout.packageRoot, path))).toBe(false);
		}
		const captured = await shepherdStampV2(layout).capture(context());
		expect(captured.manifest.source).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			captured.manifest.entries.some((entry) =>
				legacy.some((path) => entry.path.endsWith(path)),
			),
		).toBe(false);
	});

	for (const [path, selected, why] of ROWS) {
		test(`${path}: ${selected ? "selected" : "not selected"} (${why})`, () => {
			const paths = readV2Source(layout).entries.map((entry) => entry.path);
			expect(paths.includes(`package/shepherd/${path}`)).toBe(selected);
			expect(isSourcePath(path)).toBe(selected);
		});
	}

	test("a mutation of the build definition changes the identity", () => {
		const before = readV2Source(layout).source;
		put("package/scripts/shepherd-definition.ts", "definition 2\n");
		expect(readV2Source(layout).source).not.toBe(before);
	});
});

/** Framework rows: a path below the installed Troupe, selected or not. */
const FRAMEWORK_ROWS: [string, boolean, string][] = [
	["package.json", true, "metadata"],
	["lib/index.ts", true, "main entry"],
	["lib/text-imports.d.ts", true, "type entry"],
	["lib/agent-format/compiler.ts", true, "library"],
	["lib/agent-format/adapters/claude.ts", true, "nested library"],
	["lib/entries/cli.ts", true, "export entry"],
	["lib/agent-format/compiler.test.ts", false, "library test"],
	["lib/agent-format/__fixtures__/a.md", false, "library fixture"],
	["lib/entries/__snapshots__/a.snap", false, "library snapshot"],
	["lib/shepherd/tool.ts", false, "an agent's code in Troupe"],
	["lib/other.ts", false, "outside the members"],
	["scripts/compile.ts", false, "tooling"],
	["agents/shepherd.md", false, "an agent declaration"],
	["extractions/shepherd/package.json", false, "an extraction"],
	["lib/agent-format/.DS_Store", false, "host byproduct"],
];

describe("the framework origin is Troupe's library members", () => {
	for (const [path, selected, why] of FRAMEWORK_ROWS) {
		test(`${path}: ${selected ? "selected" : "not selected"} (${why})`, () => {
			put(`dist/troupe/${path}`, `${path}\n`);
			const paths = readV2Source(layout).entries.map((entry) => entry.path);
			expect(paths.includes(`framework/troupe/${path}`)).toBe(selected);
			expect(isFrameworkPath(path)).toBe(selected);
		});
	}

	test("the installed Troupe contributes no tests, tooling or agent code", () => {
		const [framework] = v2Inputs({
			packageRoot: PACKAGE_ROOT,
			troupeRoot: troupeRoot(PACKAGE_ROOT),
		});
		if (framework?.origin !== FRAMEWORK_ORIGIN) throw new Error("no framework");
		const paths = readSourceInputs(framework).files.map((file) => file.path);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.filter((path) => !isFrameworkPath(path))).toEqual([]);
		expect(paths.some((path) => /shepherd|\.test\.ts$/.test(path))).toBe(false);
	});
});

describe("v2 identity on miniature fixtures (O14, O15, O16)", () => {
	test("the framework origin is namespaced beside the package", () => {
		const paths = readV2Source(layout).entries.map((entry) => entry.path);
		expect(paths).toContain("framework/troupe/lib/agent-format/compiler.ts");
		expect(paths).toContain("framework/troupe/package.json");
	});

	test("ignore rules do not change membership, and .gitignore is itself an input", () => {
		const before = readV2Source(layout);
		put("package/.gitignore", "packages/\nlib/\n");
		const after = readV2Source(layout);
		expect(after.source).not.toBe(before.source);
		expect(after.entries.map((entry) => entry.path)).toEqual(
			before.entries.map((entry) => entry.path),
		);
	});

	test("a runtime tool's executable status is bound", () => {
		const before = readV2Source(layout);
		const tool = before.entries.find((entry) =>
			entry.path.endsWith("tools/publish-check"),
		);
		expect(tool?.executable).toBe(true);
		chmodSync(
			join(dir, "package/packages/software/tools/publish-check"),
			0o644,
		);
		expect(readV2Source(layout).source).not.toBe(before.source);
	});

	test("symlink and nonregular inputs are refused", () => {
		symlinkSync(
			join(dir, "package/packages/software/MODULE.md"),
			join(dir, "package/packages/software/LINK.md"),
		);
		expect(() => readV2Source(layout)).toThrow(SourceInputError);
		rmSync(join(dir, "package/packages/software/LINK.md"));
		expect(
			spawnSync("mkfifo", [join(dir, "package/packages/software/pipe")]).status,
		).toBe(0);
		expect(() => readV2Source(layout)).toThrow(
			"packages/software/pipe: an input must be a regular file",
		);
	});

	test("dependency identity comes from the consumer lockfile", () => {
		expect(dependencyIdentity(layout.packageRoot)).toEqual({
			requested: "file:../dist/troupe",
			resolved: "troupe@file:../dist/troupe",
		});
	});

	test("the policy records origins with unknown revisions and a v2 line", async () => {
		const policy = shepherdStampV2(layout);
		const captured = await policy.capture(context());
		expect(captured.provenance.origins).toEqual([
			expect.objectContaining({
				origin: "framework/troupe",
				revision: "file:../dist/troupe",
				marker: "local",
				dependency: {
					requested: "file:../dist/troupe",
					resolved: "troupe@file:../dist/troupe",
				},
			}),
			expect.objectContaining({
				origin: "package/shepherd",
				revision: "unknown",
				marker: "local",
			}),
		]);
		expect(policy.versionLine("shepherd", captured)).toBe(
			`shepherd troupe-agent-source-v2 framework/troupe=file:../dist/troupe+local package/shepherd=unknown+local source=${captured.manifest.source}`,
		);
		expect((await policy.recheck(context(), captured)).source).toBe(
			captured.manifest.source,
		);
		put("dist/troupe/lib/agent-format/compiler.ts", "restaged\n");
		expect((await policy.recheck(context(), captured)).source).not.toBe(
			captured.manifest.source,
		);
	});

	test("evaluation inputs are a separate selector without evidence", () => {
		const evaluation = readSourceInputs(evaluationInputs(layout.packageRoot));
		expect(evaluation.files.map((file) => file.path)).toEqual([
			"scripts/eval-source.ts",
			"evals/shepherd/rubric.yaml",
		]);
	});
});

// C17: each origin's revision carries a marker when its selected bytes are
// not those of the commit it records. Temporary fixture repositories only.
describe("revision markers (C17)", () => {
	const testGit = createGitRunner({
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	});
	const git = (...args: string[]) => {
		const result = testGit(args, dir);
		expect(result.code).toBe(0);
		return new TextDecoder().decode(result.stdout).trim();
	};
	let head: string;

	/** The fixture committed as a repository at `dir`, the package under `package/`. */
	beforeEach(() => {
		put("package/biome.json", "{}\n");
		git("init", "-q", "-b", "main");
		git("add", "-A");
		git("commit", "-q", "-m", "fixture");
		head = git("rev-parse", "HEAD");
		layout = {
			...layout,
			revision: { gitRoot: dir, prefix: "package", git: testGit },
		};
	});

	const line = async () => {
		const policy = shepherdStampV2(layout);
		const captured = await policy.capture(context());
		return {
			captured,
			line: policy
				.versionLine("shepherd", captured)
				.replace(captured.manifest.source, "<source>"),
		};
	};

	test("a clean Git package with a folder dependency", async () => {
		const { captured, line: version } = await line();
		expect(version).toBe(
			`shepherd troupe-agent-source-v2 framework/troupe=file:../dist/troupe+local package/shepherd=${head} source=<source>`,
		);
		expect(captured.provenance.origins).toEqual([
			expect.objectContaining({
				revision: "file:../dist/troupe",
				marker: "local",
			}),
			expect.objectContaining({
				revision: head,
				prefix: "package",
				marker: null,
			}),
		]);
	});

	test("an empty prefix compares the whole repository's tree", async () => {
		const root = join(dir, "package");
		const result = testGit(["init", "-q", "-b", "main"], root);
		expect(result.code).toBe(0);
		expect(testGit(["add", "-A"], root).code).toBe(0);
		expect(testGit(["commit", "-q", "-m", "nested"], root).code).toBe(0);
		const nested = new TextDecoder()
			.decode(testGit(["rev-parse", "HEAD"], root).stdout)
			.trim();
		layout = {
			...layout,
			revision: { gitRoot: root, prefix: "", git: testGit },
		};
		expect((await line()).line).toContain(`package/shepherd=${nested} `);
		put("package/agents/shepherd.md", "changed\n");
		expect((await line()).line).toContain(`package/shepherd=${nested}+dirty `);
	});

	test("a SHA-256 repository compares blobs in its own hash", async () => {
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		git("init", "-q", "-b", "main", "--object-format=sha256");
		git("add", "-A");
		git("commit", "-q", "-m", "fixture");
		const commit = git("rev-parse", "HEAD");
		expect(commit).toHaveLength(64);
		expect((await line()).line).toContain(`package/shepherd=${commit} `);
		put("package/agents/shepherd.ts", "changed\n");
		expect((await line()).line).toContain(`package/shepherd=${commit}+dirty `);
	});

	test("a modified selected file makes the package dirty", async () => {
		put("package/system-prompts/shepherd/core.md", "edited\n");
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
	});

	test("an added or removed selected file makes the package dirty", async () => {
		put("package/packages/software/NEW.md", "new\n");
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
		rmSync(join(dir, "package/packages/software/NEW.md"));
		rmSync(join(dir, "package/packages/software/MODULE.md"));
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
	});

	test("files outside the selection never make it dirty", async () => {
		put("package/biome.json", '{"changed": true}\n');
		put("package/lib/shepherd/compose.test.ts", "edited test\n");
		put("package/lib/shepherd/new.test.ts", "new test\n");
		put("package/bin/shepherd", "rebuilt\n");
		put("outside.md", "a file outside the package\n");
		expect((await line()).line).toContain(`package/shepherd=${head} `);
	});

	test("an executable-bit flip on a runtime tool makes it dirty", async () => {
		chmodSync(
			join(dir, "package/packages/software/tools/publish-check"),
			0o644,
		);
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
	});

	test("lockfile resolutions give revision text, never a verified revision", () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		expect(lockRevision(`troupe@github:owner/troupe#${commit}`)).toBe(commit);
		expect(
			lockRevision(`troupe@git+https://example.invalid/troupe.git#${commit}`),
		).toBe(commit);
		expect(lockRevision("troupe@github:owner/troupe#0123abc")).toBe("unknown");
		expect(lockRevision("troupe@git+https://example.invalid/troupe.git")).toBe(
			"unknown",
		);
		expect(lockRevision("troupe@file:../.troupe-dist/troupe")).toBe(
			"file:../.troupe-dist/troupe",
		);
		expect(lockRevision(undefined)).toBe("unknown");
	});

	test("no lockfile entry and no Git give unknown+local", async () => {
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		put("package/bun.lock", '{\n  "packages": {},\n}\n');
		expect((await line()).line).toBe(
			"shepherd troupe-agent-source-v2 framework/troupe=unknown+local package/shepherd=unknown+local source=<source>",
		);
	});
});

// C24: the framework prints the pin's full commit unmarked only when the
// request, the lockfile and the installed bytes all agree with the pin.
describe("the pin record and the framework marker (C24)", () => {
	const COMMIT = "3cce0f41106df60f81b97ae3552c6a2948825bc0";
	const REQUEST = `git+https://github.com/ag0os/troupe.git#${COMMIT}`;
	/** Verbatim from this package's regenerated bun.lock (Bun 1.2.22, GitHub tarball). */
	const TARBALL_LOCK =
		'"troupe": ["troupe@github:ag0os/troupe#3cce0f4", { "dependencies": { "typescript": "^5.6.2", "yaml": "^2", "zod": "^4" } }, "ag0os-troupe-3cce0f4"],';
	/**
	 * Derived, not captured: spike S-2's true Git tuple (row 7, taken at
	 * 36bda79 through a Git shim) with both commits replaced by the tag
	 * commit. Bun 1.2.22 cannot install this form with current Git.
	 */
	const GIT_LOCK = `"troupe": ["troupe@git+ssh://git@github.com/ag0os/troupe.git#${COMMIT}", { "dependencies": { "typescript": "^5.6.2", "yaml": "^2", "zod": "^4" } }, "${COMMIT}"],`;

	const lockWith = (tuple: string) =>
		`{\n  "lockfileVersion": 1,\n  "packages": {\n    ${tuple}\n  }\n}\n`;
	const installedDigest = () =>
		readSourceInputs(v2Inputs(layout)[0] as SourceInputDefinition).provenance
			.digest;
	const pin = (overrides: Record<string, unknown> = {}) => ({
		tag: "v0.1",
		commit: COMMIT,
		owner: "ag0os",
		repository: "troupe",
		digest: installedDigest(),
		proofs: [
			{
				date: "2026-11-10",
				bun: "1.2.22",
				checks: ["fixture"],
				evidence: "none",
			},
		],
		...overrides,
	});
	const writePin = (value: unknown) =>
		put("package/troupe-pin.json", `${JSON.stringify(value, null, "\t")}\n`);
	const framework = async () => {
		const captured = await shepherdStampV2(layout).capture(context());
		const line = shepherdStampV2(layout).versionLine("shepherd", captured);
		return line.split(" ")[2];
	};

	beforeEach(() => {
		put(
			"package/package.json",
			JSON.stringify({ dependencies: { troupe: REQUEST } }),
		);
		put("package/bun.lock", lockWith(TARBALL_LOCK));
	});

	test("the tarball fixture is this package's lock entry, byte for byte", () => {
		const lock = readFileSync(join(PACKAGE_ROOT, "bun.lock"), "utf8");
		expect(lock).toContain(`\n    ${TARBALL_LOCK}\n`);
		const requested = JSON.parse(
			readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
		).dependencies.troupe;
		expect(requested).toBe(REQUEST);
	});

	test("the tarball lock with an agreeing pin prints the full commit unmarked", async () => {
		writePin(pin());
		expect(await framework()).toBe(`framework/troupe=${COMMIT}`);
	});

	test("the true Git lock with an agreeing pin prints the full commit unmarked", async () => {
		put("package/bun.lock", lockWith(GIT_LOCK));
		writePin(pin());
		expect(await framework()).toBe(`framework/troupe=${COMMIT}`);
	});

	test("changed framework bytes mark the pinned commit dirty", async () => {
		writePin(pin());
		put("dist/troupe/lib/agent-format/compiler.ts", "changed\n");
		expect(await framework()).toBe(`framework/troupe=${COMMIT}+dirty`);
		put("package/bun.lock", lockWith(GIT_LOCK));
		expect(await framework()).toBe(`framework/troupe=${COMMIT}+dirty`);
	});

	test("a framework test file is not a framework byte", async () => {
		writePin(pin());
		put("dist/troupe/lib/agent-format/compiler.test.ts", "a test\n");
		expect(await framework()).toBe(`framework/troupe=${COMMIT}`);
	});

	test("a missing pin is local, with the lockfile's own revision text", async () => {
		expect(await framework()).toBe("framework/troupe=unknown+local");
		put("package/bun.lock", lockWith(GIT_LOCK));
		expect(await framework()).toBe(`framework/troupe=${COMMIT}+local`);
	});

	test("a pin naming another commit, owner or repository is local", async () => {
		const other = "0123456789abcdef0123456789abcdef01234567";
		for (const overrides of [
			{ commit: other },
			{ owner: "someone" },
			{ repository: "fork" },
		]) {
			writePin(pin(overrides));
			expect([overrides, await framework()]).toEqual([
				overrides,
				"framework/troupe=unknown+local",
			]);
			put("package/bun.lock", lockWith(GIT_LOCK));
			expect([overrides, await framework()]).toEqual([
				overrides,
				`framework/troupe=${COMMIT}+local`,
			]);
			put("package/bun.lock", lockWith(TARBALL_LOCK));
		}
	});

	test("a pin whose digest differs from the installed bytes is dirty", async () => {
		writePin(pin({ digest: `sha256:${"0".repeat(64)}` }));
		expect(await framework()).toBe(`framework/troupe=${COMMIT}+dirty`);
	});

	test("a request or lock that does not name the pin is local", async () => {
		writePin(pin());
		const other = "0123456789abcdef0123456789abcdef01234567";
		put(
			"package/package.json",
			JSON.stringify({
				dependencies: { troupe: REQUEST.replace(COMMIT, other) },
			}),
		);
		expect(await framework()).toBe("framework/troupe=unknown+local");
		put(
			"package/package.json",
			JSON.stringify({ dependencies: { troupe: REQUEST } }),
		);
		for (const tuple of [
			TARBALL_LOCK.replace("#3cce0f4", "#0123456"),
			TARBALL_LOCK.replace("#3cce0f4", "#3cce0f"),
			TARBALL_LOCK.replace("ag0os/troupe", "someone/troupe"),
			GIT_LOCK.replace(`.git#${COMMIT}`, `.git#${other}`),
			'"troupe": ["troupe@file:../dist/troupe", {}],',
		]) {
			put("package/bun.lock", lockWith(tuple));
			expect([tuple, (await framework())?.endsWith("+local")]).toEqual([
				tuple,
				true,
			]);
		}
	});

	test("a malformed pin is refused, not read as absent", async () => {
		const bad: [string, string][] = [
			["not JSON", "{ tag: v0.1"],
			["an array", "[]\n"],
			["a short commit", JSON.stringify(pin({ commit: "3cce0f4" }))],
			["no digest", JSON.stringify({ ...pin(), digest: undefined })],
			["a bare digest", JSON.stringify(pin({ digest: "0".repeat(64) }))],
			["an extra key", JSON.stringify(pin({ note: "x" }))],
			["no proofs", JSON.stringify({ ...pin(), proofs: undefined })],
			[
				"a proof without checks",
				JSON.stringify(
					pin({
						proofs: [
							{ date: "2026-11-10", bun: "1.2.22", checks: [], evidence: "x" },
						],
					}),
				),
			],
			["an owner path", JSON.stringify(pin({ owner: "ag0os/x" }))],
		];
		for (const [why, text] of bad) {
			put("package/troupe-pin.json", text);
			expect(() => parsePin(text)).toThrow(PinError);
			let refused: unknown;
			try {
				await shepherdStampV2(layout).capture(context());
			} catch (error) {
				refused = error;
			}
			expect([why, refused instanceof PinError]).toEqual([why, true]);
		}
	});

	test("the pin is a package source file when present", async () => {
		const without = readV2Source(layout);
		expect(isSourcePath("troupe-pin.json")).toBe(true);
		writePin(pin());
		const withPin = readV2Source(layout);
		expect(withPin.entries.map((entry) => entry.path)).toContain(
			"package/shepherd/troupe-pin.json",
		);
		expect(withPin.source).not.toBe(without.source);
	});

	test("this package's own pin agrees with its request, lock and install", () => {
		expect(
			frameworkFacts({
				packageRoot: PACKAGE_ROOT,
				troupeRoot: troupeRoot(PACKAGE_ROOT),
			}),
		).toEqual({ revision: readPin(PACKAGE_ROOT)?.commit ?? "", marker: null });
	});
});
