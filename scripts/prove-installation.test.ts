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
	consumerEnv,
	denialProbeArgv,
	denialProfile,
	judgeProbe,
	PROOF_DENIAL_VARIABLE,
	parseArgs,
	run,
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

// A1: the proof's denial self check counts only an exact witness. The
// probe reads the root itself, so a root whose `.git` is a file (a Git
// worktree) cannot pass on an unrelated error, and an unsandboxed control
// must read it first.
describe("the denial self check needs a positive witness", () => {
	const roots = () => {
		const plain = dir("witness-plain");
		writeFileSync(join(plain, "file"), "x\n");
		const worktree = dir("witness-worktree");
		writeFileSync(
			join(worktree, ".git"),
			"gitdir: /nowhere/.git/worktrees/x\n",
		);
		return { plain, worktree };
	};
	const env = { PATH: process.env.PATH ?? "", HOME: scratch };
	const probe = (root: string, profile?: string) =>
		run(
			[
				...(profile ? ["/usr/bin/sandbox-exec", "-p", profile] : []),
				...denialProbeArgv(process.execPath, root),
			],
			scratch,
			env,
		);

	test("the unsandboxed control reads each root", () => {
		for (const root of Object.values(roots())) {
			const result = probe(root);
			expect([root, result.code, result.stdout]).toEqual([
				root,
				2,
				"READABLE\n",
			]);
			expect(judgeProbe(result)).toBe("readable");
		}
	});

	// macOS refuses a nested sandbox_apply under any profile with a deny
	// rule. Inside the installation proof, which runs this suite under its
	// own denial, the case cannot run; the proof sets its variable only after
	// its controls and denial witnesses passed, and only then is it skipped.
	// Anywhere else on macOS a sandbox that cannot be applied fails the case.
	const insideProof = process.env[PROOF_DENIAL_VARIABLE] === "witnessed";

	test.skipIf(process.platform !== "darwin" || insideProof)(
		"only the denial profile passes the judge",
		() => {
			for (const root of Object.values(roots())) {
				expect([root, judgeProbe(probe(root, denialProfile([root])))]).toEqual([
					root,
					"denied",
				]);
				expect([
					root,
					judgeProbe(probe(root, "(version 1)(allow default)")),
				]).toEqual([root, "readable"]);
			}
		},
	);

	test("a silent exit or an unrelated error is unproven", () => {
		expect(judgeProbe({ code: 0, stdout: "" })).toBe("unproven");
		expect(judgeProbe({ code: 3, stdout: "ENOTDIR\n" })).toBe("unproven");
		expect(judgeProbe({ code: 0, stdout: "EPERM extra\n" })).toBe("unproven");
	});
});

// M1, R1: the consumer environment is built from an allowlist, so no
// inherited credential, proxy, runtime or unknown setting reaches the
// consumer, and the proof's cold install is token free by construction.
describe("the proof's consumer environment", () => {
	const DROPPED: Record<string, string> = {
		// The keys the old blocklist named.
		GITHUB_TOKEN: "secret-1",
		GH_TOKEN: "secret-2",
		NPM_CONFIG_REGISTRY: "secret-3",
		npm_config_userconfig: "secret-4",
		BUN_CONFIG_REGISTRY: "secret-5",
		GIT_DIR: "secret-6",
		CLAUDE_CONFIG_DIR: "secret-7",
		SHEPHERD_WORKSPACE: "secret-8",
		XDG_CONFIG_HOME: "secret-9",
		NODE_PATH: "secret-10",
		BUN_OPTIONS: "secret-11",
		CODEX_HOME: "secret-12",
		// Credentials, proxies and runtime configuration it missed.
		NPM_TOKEN: "secret-13",
		NODE_AUTH_TOKEN: "secret-14",
		BUN_AUTH_TOKEN: "secret-15",
		SSH_AUTH_SOCK: "secret-16",
		HTTP_PROXY: "secret-17",
		HTTPS_PROXY: "secret-18",
		NODE_OPTIONS: "secret-19",
		SSL_CERT_FILE: "secret-20",
		AWS_ACCESS_KEY_ID: "secret-21",
		// Anything else.
		SOME_UNKNOWN_SETTING: "secret-22",
		HOME: "secret-23",
		PATH: "secret-24",
		PROVE_INSTALLATION_DENIAL: "secret-25",
	};

	test("keeps only locale, terminal and temporary directory, then adds its own", () => {
		const { env, dropped } = consumerEnv(
			{
				...DROPPED,
				LANG: "C",
				LC_ALL: "C",
				LC_CTYPE: "UTF-8",
				TERM: "dumb",
				TMPDIR: "/scratch/tmp",
			},
			"/scratch/parent",
			"/proof/bin:/usr/bin",
		);
		expect(dropped).toEqual(Object.keys(DROPPED).sort());
		expect(JSON.stringify(dropped)).not.toContain("secret");
		expect(env).toEqual({
			LANG: "C",
			LC_ALL: "C",
			LC_CTYPE: "UTF-8",
			TERM: "dumb",
			TMPDIR: "/scratch/tmp",
			HOME: "/scratch/parent/home",
			XDG_CONFIG_HOME: "/scratch/parent/config",
			BUN_INSTALL_CACHE_DIR: "/scratch/parent/bun-cache",
			PATH: "/proof/bin:/usr/bin",
			NO_COLOR: "1",
		});
		expect(JSON.stringify(env)).not.toContain("secret");
	});
});
