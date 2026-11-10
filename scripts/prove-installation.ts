#!/usr/bin/env bun
/**
 * The installation proof: clone one commit of this repository into an
 * empty directory outside every checkout, install it frozen, run the three
 * gates and one build, and check that nothing in the result came from the
 * roots it must stay away from.
 *
 * Before cloning it refuses a parent that is not an empty directory, sits
 * below a Git, `.shepherd` or `node_modules` ancestor, is inside a Git work
 * tree, or lies within an avoided root. Each avoided root is first shown
 * readable without the denial (a control that must print `READABLE`). Only
 * the clone runs unsandboxed; on macOS every other process, the checkout
 * included, runs under a `sandbox-exec` profile that denies reads of the
 * avoided roots, and the denial is shown to bite (`EPERM` or `EACCES`)
 * before anything else runs. Elsewhere only the control runs and the report
 * records that no denial ran.
 *
 * Afterwards it scans the generated entry and the binary for each avoided
 * root's path, checks that the clone's tracked files still equal the
 * commit, and checks the installed framework bytes against the pin (the
 * framework part of the version line must be unmarked).
 *
 * Usage:
 *   bun scripts/prove-installation.ts --commit <40 hex> --parent <empty dir>
 *     --evidence <dir> [--source <repository>] [--avoid <root>]...
 *     [--drop-avoided-path]
 *
 * The consumer environment is built from an allowlist (`consumerEnv`), so
 * it inherits no credentials, proxies or runtime configuration; the report
 * names the dropped keys.
 * `--source` defaults to this repository. `--drop-avoided-path` removes PATH
 * entries inside an avoided root from the consumer environment.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Ran {
	argv: string[];
	cwd: string;
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Whether `path` is `root` or lies beneath it (both already real paths). */
export function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/**
 * Refusals before any clone. Returns the ancestors checked, the parent
 * first. Every avoided root must exist, so a misspelt root cannot silently
 * weaken the denial.
 */
export function checkParent(
	parent: string,
	avoid: readonly string[],
): string[] {
	if (!existsSync(parent)) throw new Error(`parent ${parent} does not exist`);
	const dir = realpathSync(parent);
	if (!lstatSync(dir).isDirectory())
		throw new Error(`parent ${dir} is not a directory`);
	if (readdirSync(dir).length > 0)
		throw new Error(`parent ${dir} is not empty`);
	for (const root of avoid) {
		if (!existsSync(root))
			throw new Error(`avoided root ${root} does not exist`);
		if (isWithin(realpathSync(root), dir))
			throw new Error(`parent ${dir} is within avoided root ${root}`);
	}
	const ancestors: string[] = [];
	for (let at = dir; ; at = dirname(at)) {
		ancestors.push(at);
		for (const name of [".git", ".shepherd", "node_modules"]) {
			if (existsSync(join(at, name)))
				throw new Error(`prohibited ancestor ${join(at, name)}`);
		}
		if (at === dirname(at)) break;
	}
	const inside = spawnSync("git", ["rev-parse", "--git-dir"], {
		cwd: dir,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: "" },
	});
	if (inside.status === 0) throw new Error(`parent ${dir} is inside Git`);
	return ancestors;
}

/** The one line `sandbox-exec` profile denying reads of every root. */
export function denialProfile(roots: readonly string[]): string {
	const paths = roots
		.map((root) => `(subpath ${JSON.stringify(realpathSync(root))})`)
		.join(" ");
	return `(version 1)(allow default)(deny file-read* ${paths})`;
}

/**
 * The denial probe for one root: reads the root itself, prints what
 * happened and exits explicitly, so no uncaught error decides its status
 * (Bun 1.2.22 exits 0 silently for an uncaught fs error under `-e`).
 * Readable: `READABLE`, exit 2. Denied: the code, exit 0. Otherwise: the
 * code, exit 3.
 */
export function denialProbeArgv(bun: string, root: string): string[] {
	return [
		bun,
		"--no-install",
		"-e",
		`let out = "READABLE"; let status = 2; try { require("node:fs").readdirSync(${JSON.stringify(root)}); } catch (e) { out = String(e?.code ?? e); status = out === "EPERM" || out === "EACCES" ? 0 : 3; } console.log(out); process.exit(status);`,
	];
}

/** What a probe run showed: only an exact witness counts. */
export function judgeProbe(result: {
	code: number | null;
	stdout: string;
}): "denied" | "readable" | "unproven" {
	if (result.code === 0 && /^(EPERM|EACCES)\n$/.test(result.stdout))
		return "denied";
	if (result.code === 2 && result.stdout === "READABLE\n") return "readable";
	return "unproven";
}

/** Absolute PATH entries inside an avoided root; relative ones name no fixed place. */
export function avoidedPathEntries(
	path: string,
	roots: readonly string[],
): string[] {
	const real = roots.map((root) => realpathSync(root));
	return path
		.split(":")
		.filter((entry) => isAbsolute(entry))
		.filter((entry) => {
			const at = existsSync(entry) ? realpathSync(entry) : entry;
			return real.some((root) => isWithin(root, at));
		});
}

interface Args {
	commit: string;
	parent: string;
	evidence: string;
	source: string;
	avoid: string[];
	dropAvoidedPath: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
	const avoid: string[] = [];
	const single: Record<string, string> = {};
	let dropAvoidedPath = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--drop-avoided-path") {
			dropAvoidedPath = true;
			continue;
		}
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new Error(`expected --name value, got ${flag}`);
		i++;
		if (flag === "--avoid") avoid.push(value);
		else if (["--commit", "--parent", "--evidence", "--source"].includes(flag))
			single[flag.slice(2)] = value;
		else throw new Error(`unknown flag ${flag}`);
	}
	const { commit, parent, evidence } = single;
	if (!commit || !/^[0-9a-f]{40}$/.test(commit))
		throw new Error("--commit must be a full 40 hex commit");
	if (!parent || !evidence)
		throw new Error("--parent and --evidence are required");
	return {
		commit,
		parent,
		evidence: resolve(evidence),
		source: resolve(single.source ?? join(import.meta.dir, "..")),
		avoid,
		dropAvoidedPath,
	};
}

export function run(
	argv: string[],
	cwd: string,
	env: Record<string, string>,
): Ran {
	const [command, ...rest] = argv;
	const child = spawnSync(command ?? "", rest, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 1 << 30,
	});
	return {
		argv,
		cwd,
		code: child.error ? 127 : child.status,
		stdout: child.stdout ?? "",
		stderr: child.error ? child.error.message : (child.stderr ?? ""),
	};
}

/** The only inherited settings the consumer keeps: locale, terminal, temporary directory. */
export const KEPT_KEYS = ["LANG", "TERM", "TMPDIR"] as const;
const KEPT_PREFIXES = ["LC_"] as const;

/**
 * Set by the proof in the consumer environment once its own controls and
 * denial witnesses have passed. The suite's sandboxed denial test skips
 * only under it, since macOS refuses a nested sandbox inside the proof's.
 */
export const PROOF_DENIAL_VARIABLE = "PROVE_INSTALLATION_DENIAL";

/**
 * The consumer environment over `source`, built from an allowlist: the
 * kept locale, terminal and temporary directory settings, then a scratch
 * HOME, configuration and Bun cache under `parent`, the given PATH and
 * `NO_COLOR`. Everything else is dropped; `dropped` names the keys, never
 * values.
 */
export function consumerEnv(
	source: Record<string, string | undefined>,
	parent: string,
	path: string,
): { env: Record<string, string>; dropped: string[] } {
	const env: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const kept =
			(KEPT_KEYS as readonly string[]).includes(key) ||
			KEPT_PREFIXES.some((prefix) => key.startsWith(prefix));
		if (kept) env[key] = value;
		else dropped.push(key);
	}
	return {
		env: {
			...env,
			HOME: join(parent, "home"),
			XDG_CONFIG_HOME: join(parent, "config"),
			BUN_INSTALL_CACHE_DIR: join(parent, "bun-cache"),
			PATH: path,
			NO_COLOR: "1",
		},
		dropped: dropped.sort(),
	};
}

const ENTRY_PROBE = `
import { writeFileSync } from "node:fs";
import { generateEntry, loadAgentDefinition } from "troupe/compiler";
import { shepherdDefinition, PACKAGE_ROOT, troupeRoot } from "../scripts/shepherd-definition";
import { frameworkFacts, readPin } from "../scripts/shepherd-source-v2";
const agent = await loadAgentDefinition(shepherdDefinition(), "agents/shepherd.md");
writeFileSync(process.argv[2], generateEntry(agent));
console.log(JSON.stringify({
	pin: readPin(PACKAGE_ROOT),
	framework: frameworkFacts({ packageRoot: PACKAGE_ROOT, troupeRoot: troupeRoot(PACKAGE_ROOT) }),
}));
`;

async function prove(args: Args): Promise<boolean> {
	const ancestors = checkParent(args.parent, args.avoid);
	const parent = realpathSync(args.parent);
	if (isWithin(parent, resolve(args.evidence)))
		throw new Error("keep the evidence directory outside the parent");
	mkdirSync(args.evidence, { recursive: true });
	const roots = args.avoid.map((root) => realpathSync(root));
	const denial =
		process.platform === "darwin" && roots.length > 0
			? ["/usr/bin/sandbox-exec", "-p", denialProfile(roots)]
			: [];
	const inherited = process.env.PATH ?? "";
	const avoidedOnPath = avoidedPathEntries(inherited, roots);
	const path = args.dropAvoidedPath
		? inherited
				.split(":")
				.filter((entry) => !avoidedOnPath.includes(entry))
				.join(":")
		: inherited;
	const { env, dropped } = consumerEnv(process.env, parent, path);
	mkdirSync(env.HOME ?? "", { recursive: true });
	mkdirSync(env.XDG_CONFIG_HOME ?? "", { recursive: true });
	const steps: { name: string; code: number | null; expected?: number }[] = [];
	const save = (name: string, result: Ran) => {
		writeFileSync(join(args.evidence, `${name}.stdout`), result.stdout);
		writeFileSync(join(args.evidence, `${name}.stderr`), result.stderr);
	};
	const step = (
		name: string,
		argv: string[],
		cwd: string,
		options: {
			sandboxed?: boolean;
			expected?: number;
			env?: Record<string, string>;
		} = {},
	): Ran => {
		const expected = options.expected ?? 0;
		console.log(`running ${name}`);
		const result = run(
			[...(options.sandboxed === false ? [] : denial), ...argv],
			cwd,
			options.env ?? env,
		);
		save(name, result);
		steps.push({ name, code: result.code, expected });
		if (result.code !== expected)
			throw new Error(
				`${name} exited ${result.code}, expected ${expected}:\n${`${result.stdout}${result.stderr}`.slice(-4000)}`,
			);
		return result;
	};
	const bun = process.execPath;
	const clone = join(parent, "shepherd");
	const report: Record<string, unknown> = {
		commit: args.commit,
		bun: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		parentAncestorsChecked: ancestors.length,
		avoided: roots,
		denial:
			denial.length > 0
				? { tool: "sandbox-exec", profile: denial[2] }
				: `none: ${process.platform === "darwin" ? "no roots given" : "not macOS"}`,
		avoidedPathEntries: avoidedOnPath,
		droppedAvoidedPath: args.dropAvoidedPath,
		droppedEnv: dropped,
		steps,
	};
	const finish = (ok: boolean, failure?: string) => {
		report.result = ok ? "pass" : "fail";
		if (failure) report.failure = failure;
		writeFileSync(
			join(args.evidence, "installation.json"),
			`${JSON.stringify(report, null, "\t")}\n`,
		);
		return ok;
	};
	try {
		const probe = (name: string, root: string, sandboxed: boolean) => {
			const want = sandboxed ? "denied" : "readable";
			console.log(`running ${name}`);
			const result = run(
				[...(sandboxed ? denial : []), ...denialProbeArgv(bun, root)],
				parent,
				env,
			);
			save(name, result);
			steps.push({ name, code: result.code, expected: sandboxed ? 0 : 2 });
			if (judgeProbe(result) !== want)
				throw new Error(
					`${name}: ${root} is not shown ${want}: exit ${result.code}, stdout ${JSON.stringify(result.stdout)}`,
				);
		};
		for (const [i, root] of roots.entries()) probe(`control-${i}`, root, false);
		if (denial.length > 0) {
			for (const [i, root] of roots.entries()) probe(`denied-${i}`, root, true);
		}
		step(
			"clone",
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"clone",
				"--quiet",
				"--no-local",
				"--no-checkout",
				args.source,
				clone,
			],
			parent,
			{ sandboxed: false },
		);
		step(
			"checkout",
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"checkout",
				"--quiet",
				"--detach",
				args.commit,
			],
			clone,
		);
		const head = step(
			"head",
			["git", "rev-parse", "HEAD", "HEAD^{tree}"],
			clone,
		)
			.stdout.trim()
			.split("\n");
		if (head[0] !== args.commit)
			throw new Error(`clone HEAD ${head[0]} is not ${args.commit}`);
		report.tree = head[1];
		step("install", [bun, "install", "--frozen-lockfile"], clone);
		step("resolution", [bun, "--no-install", "scripts/resolution.ts"], clone);
		step("typecheck", [bun, "--no-install", "run", "typecheck"], clone);
		step("biome", [bun, "--no-install", "run", "check"], clone);
		let tests = run([...denial, bun, "--no-install", "test"], clone, env);
		save("tests", tests);
		steps.push({ name: "tests", code: tests.code, expected: 0 });
		if (tests.code !== 0) {
			console.log("tests failed once; one rerun on the same head");
			tests = run([...denial, bun, "--no-install", "test"], clone, env);
			save("tests-rerun", tests);
			steps.push({ name: "tests-rerun", code: tests.code, expected: 0 });
		}
		const counts = (text: string) =>
			Object.fromEntries(
				[...text.matchAll(/^\s*(\d+) (pass|fail|skip)$/gm)].map((m) => [
					m[2],
					Number(m[1]),
				]),
			);
		report.tests = counts(tests.stderr + tests.stdout);
		if (tests.code !== 0) throw new Error("the suite failed twice");
		step("build", [bun, "--no-install", "run", "compile", "shepherd"], clone);
		const built = readdirSync(join(clone, "bin"));
		if (built.join() !== "shepherd")
			throw new Error(`bin/ holds ${built.join(", ")}`);
		const binary = join(clone, "bin/shepherd");
		const version = step("version", [binary, "--version"], clone).stdout.trim();
		report.version = version;
		if (!/ framework\/troupe=[0-9a-f]{40} /.test(` ${version} `))
			throw new Error(
				`the framework part is not an unmarked commit: ${version}`,
			);
		if (!version.includes(` package/shepherd=${args.commit} `))
			throw new Error(
				`the package part is not the unmarked commit: ${version}`,
			);
		const entryFile = join(parent, "generated-entry.ts");
		writeFileSync(join(clone, "node_modules/.proof-entry.ts"), ENTRY_PROBE);
		const facts = JSON.parse(
			step(
				"entry",
				[bun, "--no-install", "node_modules/.proof-entry.ts", entryFile],
				clone,
			).stdout,
		);
		report.pin = facts.pin;
		report.framework = facts.framework;
		if (
			facts.framework.marker !== null ||
			facts.framework.revision !== facts.pin?.commit
		)
			throw new Error(
				`installed framework does not match the pin: ${JSON.stringify(facts.framework)}`,
			);
		const entry = readFileSync(entryFile);
		const bytes = readFileSync(binary);
		report.scans = [...new Set([...roots, realpathSync(args.source)])].map(
			(root) => {
				const scan = {
					path: root,
					entryContains: entry.includes(root),
					binaryContains: bytes.includes(root),
				};
				if (scan.entryContains || scan.binaryContains)
					throw new Error(`the entry or binary names ${root}`);
				return scan;
			},
		);
		const doctor = run(
			[...denial, binary, "tool", "doctor", "--json"],
			parent,
			{ ...env, PATH: `${join(clone, "bin")}:${env.PATH}` },
		);
		save("doctor", doctor);
		steps.push({ name: "doctor", code: doctor.code });
		const checks = (
			JSON.parse(doctor.stdout) as {
				checks: { id: string; status: string; subject?: string }[];
			}
		).checks;
		const check = (id: string) => checks.find((entry) => entry.id === id);
		report.doctor = {
			code: doctor.code,
			base: check("packages:base"),
			path: check("path:shepherd"),
		};
		if (
			check("packages:base")?.status !== "ok" ||
			check("packages:base")?.subject !== join(clone, "packages") ||
			check("path:shepherd")?.status !== "ok"
		)
			throw new Error(
				"doctor did not find the binary on PATH with its packages",
			);
		const status = step(
			"status",
			["git", "status", "--porcelain=v1", "--untracked-files=all"],
			clone,
		).stdout;
		const tree = step(
			"tree-after",
			["git", "rev-parse", "HEAD^{tree}"],
			clone,
		).stdout.trim();
		report.cloneClean = status === "" && tree === report.tree;
		if (!report.cloneClean) throw new Error(`the clone changed:\n${status}`);
		return finish(true);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return finish(
			false,
			error instanceof Error ? error.message : String(error),
		);
	}
}

if (import.meta.main) {
	const ok = await prove(parseArgs(process.argv.slice(2)));
	console.log(ok ? "PASS installation proof" : "FAIL installation proof");
	process.exit(ok ? 0 : 1);
}
