/**
 * Shepherd source identity, v2: package-relative, table-driven membership
 * over two origins, `framework/troupe` (the installed Troupe bytes the build
 * selects) and `package/shepherd` (the Shepherd package). It is Shepherd
 * policy, built on Troupe's generic `troupe/provenance` helpers. Builds
 * from Troupe's own tree before `v0.1` carry the v1 stamp, whose identities
 * are never relabeled.
 *
 * Membership is explicit. Git ignore rules play no part: the package's own
 * `.gitignore` is an input, and a host's global excludes cannot change what
 * is hashed. Outputs and generated eval evidence are never selected;
 * evaluation inputs have their own selector.
 *
 * The table is the package's: its build definition, build and watch scripts
 * and this policy. `biome.json` is not a build input and is left out. One
 * implementation selects: `isSourcePath` decides, and the reader walks the
 * trees and keeps exactly the paths it accepts.
 *
 * Each origin's revision carries a marker (C17, C24): the framework's is the
 * pin record's commit when the request, the lockfile and the installed
 * bytes all agree with it (`frameworkMarking`), and the lockfile's text
 * marked `local` otherwise; the package's is its Git `HEAD`,
 * marked `dirty` when the selected files differ from that commit's tree
 * under the prefix. Unlike v1's repository-wide `dirty`, only selected bytes
 * count.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BuildStampPolicy,
	CapturedBuildStamp,
	StampJson,
} from "troupe/compiler";
import {
	combineSourceInputs,
	createGitRunner,
	type GitRunner,
	type InputProvenance,
	readSourceInputs,
	type SourceInput,
	type SourceInputDefinition,
	type SourceManifest,
} from "troupe/provenance";

const SOURCE_DOMAIN_V2 = "troupe-agent-source-v2";
export const FRAMEWORK_ORIGIN = "framework/troupe";
export const PACKAGE_ORIGIN = "package/shepherd";

/**
 * Package files every v2 Shepherd identity reads. Each must exist except
 * the pin record, which is selected when present.
 */
export const PACKAGE_FILES = [
	".gitignore",
	"agents/shepherd.md",
	"agents/shepherd.ts",
	"bun.lock",
	"package.json",
	"scripts/build.ts",
	"scripts/shepherd-definition.ts",
	"scripts/shepherd-source-v2.ts",
	"scripts/watch.ts",
	"troupe-pin.json",
	"tsconfig.json",
] as const;

/** The pin record: Troupe's tag, commit, framework digest and proof list. */
export const PIN_FILE = "troupe-pin.json";

/**
 * Package trees selected recursively. Where `tests` is false, `*.test.ts`,
 * `*.spec.ts` and paths beneath `__fixtures__` or `__snapshots__` are left
 * out; other helpers stay selected.
 */
const PACKAGE_TREES = [
	{ dir: "lib/shepherd", tests: false },
	{ dir: "packages", tests: true },
	{ dir: "system-prompts/shepherd", tests: true },
] as const;

/** Never selected: outputs and eval evidence. */
const EXCLUDED_DIRS = [
	"bin",
	"evals/shepherd/artifacts",
	"evals/shepherd/results",
	"evals/shepherd/validation",
] as const;

/** Names never selected anywhere: host and tool byproducts. */
const EXCLUDED_NAMES = new Set([".DS_Store", "node_modules", "__pycache__"]);

/** Runtime tools, whose executable status dispatch checks. */
function isRuntimeTool(path: string): boolean {
	return /^packages\/[^/]+\/tools\//.test(path);
}

/**
 * Judged on every path component, names and suffixes alike, so a byproduct
 * directory hides its contents and the selector agrees with the traversal,
 * which prunes an excluded directory without visiting it.
 */
function excluded(path: string): boolean {
	const parts = path.split("/");
	return (
		parts.some((part) => EXCLUDED_NAMES.has(part) || part.endsWith(".pyc")) ||
		EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))
	);
}

function isTestPath(path: string): boolean {
	const parts = path.split("/");
	const name = parts.pop() ?? "";
	return (
		name.endsWith(".test.ts") ||
		name.endsWith(".spec.ts") ||
		parts.includes("__fixtures__") ||
		parts.includes("__snapshots__")
	);
}

/**
 * Troupe's library members, the only installed bytes the framework origin
 * selects. A Git dependency installs the whole repository, so anything
 * wider would hash Troupe's tooling, tests and any agents it still holds.
 */
export const FRAMEWORK_FILES = [
	"lib/index.ts",
	"lib/text-imports.d.ts",
	"package.json",
] as const;
export const FRAMEWORK_TREES = ["lib/agent-format", "lib/entries"] as const;

/** Whether a path below the installed Troupe is part of the framework origin. */
export function isFrameworkPath(path: string): boolean {
	if (excluded(path)) return false;
	if ((FRAMEWORK_FILES as readonly string[]).includes(path)) return true;
	return FRAMEWORK_TREES.some(
		(dir) => path.startsWith(`${dir}/`) && !isTestPath(path),
	);
}

/** Whether a package-relative path is part of the v2 package origin. */
export function isSourcePath(path: string): boolean {
	if (excluded(path)) return false;
	if ((PACKAGE_FILES as readonly string[]).includes(path)) return true;
	return PACKAGE_TREES.some(
		(tree) =>
			path.startsWith(`${tree.dir}/`) && (tree.tests || !isTestPath(path)),
	);
}

/**
 * The package's eval build seam, which gives the evals their build identity
 * and compiler. The build never reads it, so it is an evaluation input.
 */
export const EVAL_SEAM = "scripts/eval-source.ts";

/** The evaluation harness's inputs: a selector separate from source. */
export function evaluationInputs(packageRoot: string): SourceInputDefinition {
	return {
		origin: "evaluation/shepherd",
		root: packageRoot,
		files: [EVAL_SEAM],
		trees: [{ dir: "evals/shepherd" }],
		exclude: excluded,
	};
}

export interface V2Layout {
	/** The package's directory. */
	packageRoot: string;
	/**
	 * The real directory the installed compiler runs from, derived from the
	 * `realpath` of an installed file such as `lib/agent-format/compiler.ts`.
	 * Never `node_modules/troupe` walked directly: Bun 1.2.22 installs a
	 * `file:` dependency as per-file symlinks, which `readSourceInputs`
	 * refuses (1.4.4 uses hardlinks).
	 */
	troupeRoot: string;
	/** Where the package's Git revision is read, when known. */
	revision?: { gitRoot: string; prefix: string; git?: GitRunner };
}

/** The `troupe` dependency as the package and its lockfile record it. */
export function dependencyIdentity(packageRoot: string): {
	requested?: string;
	resolved?: string;
} {
	const identity: { requested?: string; resolved?: string } = {};
	try {
		const pkg = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		);
		const requested = pkg.dependencies?.troupe;
		if (typeof requested === "string") identity.requested = requested;
	} catch {}
	try {
		const text = readFileSync(join(packageRoot, "bun.lock"), "utf8");
		// bun.lock is JSON with trailing commas.
		const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
		const resolved = lock.packages?.troupe?.[0];
		if (typeof resolved === "string") identity.resolved = resolved;
	} catch {}
	return identity;
}

/** Both origins' explicit membership. */
export function v2Inputs(layout: V2Layout): SourceInputDefinition[] {
	return [
		{
			origin: FRAMEWORK_ORIGIN,
			root: layout.troupeRoot,
			files: FRAMEWORK_FILES,
			trees: FRAMEWORK_TREES.map((dir) => ({ dir })),
			exclude: (path) => !isFrameworkPath(path),
			dependency: dependencyIdentity(layout.packageRoot),
		},
		{
			origin: PACKAGE_ORIGIN,
			root: layout.packageRoot,
			files: PACKAGE_FILES.filter(
				(path) =>
					path !== PIN_FILE || existsSync(join(layout.packageRoot, PIN_FILE)),
			),
			trees: PACKAGE_TREES.map((tree) => ({ dir: tree.dir })),
			// The reader keeps exactly what `isSourcePath` accepts.
			exclude: (path) => !isSourcePath(path),
			executables: isRuntimeTool,
			...(layout.revision ? { revision: layout.revision } : {}),
		},
	];
}

/** The v2 manifest of both origins as they are now. */
export function readV2Source(layout: V2Layout): SourceManifest {
	return combineSourceInputs(
		SOURCE_DOMAIN_V2,
		v2Inputs(layout).map(readSourceInputs),
	).manifest;
}

/**
 * How an origin's selected bytes relate to the revision it records: `local`
 * when it records no commit they can be compared with, `dirty` when they
 * differ from that commit, `null` when they equal it.
 */
export type OriginMarker = "local" | "dirty" | null;

const FULL_COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_SPECIFIER =
	/^(github:|gitlab:|bitbucket:|git\+|git:\/\/|git@|ssh:\/\/|https?:\/\/[^#]*\.git(#|$))/;

/**
 * The revision text the lockfile alone gives `troupe`: the commit of a Git
 * resolution that records a full one, `unknown` for any other Git or GitHub
 * resolution, or the resolution itself (a folder, say). It is never a
 * verified revision; `frameworkMarking` decides the marker.
 */
export function lockRevision(resolved: string | undefined): string {
	const resolution = resolved?.startsWith("troupe@")
		? resolved.slice("troupe@".length)
		: undefined;
	if (!resolution) return "unknown";
	if (GIT_SPECIFIER.test(resolution)) {
		const commit = resolution.split("#").at(1) ?? "";
		return FULL_COMMIT.test(commit) ? commit : "unknown";
	}
	return resolution;
}

/** One recorded proof of the pin: when, under which Bun, what ran, where its evidence is. */
export interface PinProof {
	date: string;
	bun: string;
	checks: string[];
	evidence: string;
}

/**
 * The pin record. `digest` is the framework origin's own digest of the
 * library members at `commit` (`troupe-agent-origin-v2` framing), derived
 * from the tag's Git tree by `scripts/pin-digest.ts`.
 */
export interface TroupePin {
	tag: string;
	commit: string;
	owner: string;
	repository: string;
	digest: string;
	proofs: PinProof[];
}

/** A pin record that exists but cannot be read as one. */
export class PinError extends Error {
	constructor(readonly problems: string[]) {
		super(`${PIN_FILE}: ${problems.join("; ")}`);
		this.name = "PinError";
	}
}

const PIN_KEYS = ["commit", "digest", "owner", "proofs", "repository", "tag"];
const PROOF_KEYS = ["bun", "checks", "date", "evidence"];
const NAME = /^[A-Za-z0-9._-]+$/;

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function keysProblem(
	where: string,
	value: Record<string, unknown>,
	keys: string[],
): string[] {
	const found = Object.keys(value).sort();
	return found.join() === keys.join()
		? []
		: [`${where} must have exactly the keys ${keys.join(", ")}`];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pin record in `text`, or a `PinError` naming every problem. */
export function parsePin(text: string): TroupePin {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new PinError([`not JSON: ${(error as Error).message}`]);
	}
	if (!isObject(value)) throw new PinError(["not a JSON object"]);
	const problems = keysProblem("the record", value, PIN_KEYS);
	if (!nonEmpty(value.tag)) problems.push("tag must be a nonempty string");
	if (typeof value.commit !== "string" || !FULL_COMMIT.test(value.commit))
		problems.push("commit must be a full lowercase hex commit");
	for (const key of ["owner", "repository"] as const) {
		const name = value[key];
		if (typeof name !== "string" || !NAME.test(name))
			problems.push(`${key} must be a GitHub name`);
	}
	if (
		typeof value.digest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(value.digest)
	)
		problems.push("digest must be sha256:<64 lowercase hex>");
	if (!Array.isArray(value.proofs)) {
		problems.push("proofs must be an array");
	} else {
		value.proofs.forEach((proof, i) => {
			const where = `proofs[${i}]`;
			if (!isObject(proof)) return problems.push(`${where} must be an object`);
			problems.push(...keysProblem(where, proof, PROOF_KEYS));
			if (
				typeof proof.date !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(proof.date)
			)
				problems.push(`${where}.date must be YYYY-MM-DD`);
			if (!nonEmpty(proof.bun)) problems.push(`${where}.bun must be a version`);
			if (
				!Array.isArray(proof.checks) ||
				proof.checks.length === 0 ||
				!proof.checks.every(nonEmpty)
			)
				problems.push(`${where}.checks must list nonempty strings`);
			if (!nonEmpty(proof.evidence))
				problems.push(`${where}.evidence must be a nonempty string`);
		});
	}
	if (problems.length > 0) throw new PinError(problems);
	return value as unknown as TroupePin;
}

/** The package's pin record, or undefined when it has none. A malformed one is refused. */
export function readPin(packageRoot: string): TroupePin | undefined {
	const path = join(packageRoot, PIN_FILE);
	if (!existsSync(path)) return undefined;
	return parsePin(readFileSync(path, "utf8"));
}

/** A GitHub repository and ref named by a specifier or resolution. */
function githubRef(
	text: string,
): { owner: string; repository: string; ref: string } | undefined {
	const match =
		/^(?:github:|(?:git\+)?(?:https|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?#([0-9a-f]+)$/.exec(
			text,
		);
	if (!match) return undefined;
	const [, owner = "", repository = "", ref = ""] = match;
	return { owner, repository, ref };
}

/**
 * Whether the package's request and its lockfile both name the pin: the
 * request at the pin's full commit, and the lock either at that full commit
 * (a Git resolution) or, for Bun's GitHub tarball resolution, at a hex
 * prefix of at least seven of it; both in the pin's owner and repository.
 */
export function namesPin(
	dependency: { requested?: string; resolved?: string } | undefined,
	pin: TroupePin,
): boolean {
	const same = (ref: ReturnType<typeof githubRef>) =>
		ref !== undefined &&
		ref.owner === pin.owner &&
		ref.repository === pin.repository;
	const requested = githubRef(dependency?.requested ?? "");
	if (!same(requested) || requested?.ref !== pin.commit) return false;
	const resolution = dependency?.resolved?.startsWith("troupe@")
		? dependency.resolved.slice("troupe@".length)
		: "";
	const locked = githubRef(resolution);
	if (!same(locked) || !locked) return false;
	return resolution.startsWith("github:")
		? locked.ref.length >= 7 && pin.commit.startsWith(locked.ref)
		: locked.ref === pin.commit;
}

/**
 * The framework's revision and marker (C24). The pin's full commit prints
 * unmarked only when the request and the lockfile name the pin and the
 * installed members hash to the pin's digest; with the names agreeing and
 * the bytes not, it is marked `dirty`. With no pin, or no agreement, the
 * lockfile's own revision text is marked `local`.
 */
export function frameworkMarking(
	dependency: { requested?: string; resolved?: string } | undefined,
	pin: TroupePin | undefined,
	installedDigest: string,
): { revision: string; marker: OriginMarker } {
	if (!pin || !namesPin(dependency, pin)) {
		return { revision: lockRevision(dependency?.resolved), marker: "local" };
	}
	return {
		revision: pin.commit,
		marker: installedDigest === pin.digest ? null : "dirty",
	};
}

/** The framework origin's verified facts for a package and its installed Troupe. */
export function frameworkFacts(layout: {
	packageRoot: string;
	troupeRoot: string;
}): { revision: string; marker: OriginMarker } {
	const [framework] = v2Inputs(layout);
	if (!framework) throw new Error("v2 inputs name no framework origin");
	return frameworkMarking(
		framework.dependency,
		readPin(layout.packageRoot),
		readSourceInputs(framework).provenance.digest,
	);
}

/** Git's object id for `bytes` as a blob, in the repository's hash. */
function blobId(bytes: Uint8Array, algorithm: "sha1" | "sha256"): string {
	return createHash(algorithm)
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

/**
 * Whether the package's selected files equal the commit's tree under the
 * prefix: the same accepted paths, blob ids and, for runtime tools, mode.
 * Files outside the selection (tests under `lib/shepherd`, `biome.json`)
 * never make the package dirty.
 */
function packageMarker(
	input: SourceInput,
	revision: NonNullable<V2Layout["revision"]>,
): OriginMarker {
	const commit = input.provenance.revision;
	if (!FULL_COMMIT.test(commit)) return "local";
	const git = revision.git ?? createGitRunner();
	const prefix = revision.prefix.replace(/^\.\//, "").replace(/\/+$/, "");
	const listed = git(
		[
			"--literal-pathspecs",
			"ls-tree",
			"-r",
			"-z",
			"--full-tree",
			commit,
			...(prefix ? ["--", prefix] : []),
		],
		revision.gitRoot,
	);
	if (listed.code !== 0) return "local";
	const head = new Map<string, { mode: string; id: string }>();
	for (const record of new TextDecoder().decode(listed.stdout).split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode = "", , id = ""] = record.slice(0, tab).split(" ");
		const full = record.slice(tab + 1);
		if (prefix && !full.startsWith(`${prefix}/`)) continue;
		const path = prefix ? full.slice(prefix.length + 1) : full;
		if (isSourcePath(path)) head.set(path, { mode, id });
	}
	const algorithm = commit.length === 64 ? "sha256" : "sha1";
	const same =
		head.size === input.files.length &&
		input.files.every((file) => {
			const entry = head.get(file.path);
			return (
				entry !== undefined &&
				entry.id === blobId(file.content, algorithm) &&
				(!isRuntimeTool(file.path) ||
					(entry.mode === "100755") === file.executable)
			);
		});
	return same ? null : "dirty";
}

/** Each origin's provenance with its derived revision and marker. */
function markedOrigins(
	layout: V2Layout,
	inputs: readonly SourceInput[],
): (InputProvenance & { marker: OriginMarker })[] {
	return inputs.map((input) => {
		if (input.origin === FRAMEWORK_ORIGIN) {
			return {
				...input.provenance,
				...frameworkMarking(
					input.provenance.dependency,
					readPin(layout.packageRoot),
					input.provenance.digest,
				),
			};
		}
		return {
			...input.provenance,
			marker: layout.revision ? packageMarker(input, layout.revision) : "local",
		};
	});
}

/**
 * The v2 stamp as a `BuildStampPolicy`. Its version line names the domain,
 * each origin's revision (`unknown` when unknown) with its marker, and the
 * digest.
 */
export function shepherdStampV2(layout: V2Layout): BuildStampPolicy {
	return {
		capture() {
			const inputs = v2Inputs(layout).map(readSourceInputs);
			const combined = combineSourceInputs(SOURCE_DOMAIN_V2, inputs);
			return {
				manifest: combined.manifest,
				provenance: {
					domain: SOURCE_DOMAIN_V2,
					origins: markedOrigins(layout, inputs).map(
						(origin) => JSON.parse(JSON.stringify(origin)) as StampJson,
					),
				},
			};
		},
		recheck: () => readV2Source(layout),
		versionLine: (agentId, captured) => v2VersionLine(agentId, captured),
	};
}

/**
 * `<agent> troupe-agent-source-v2 framework/troupe=<rev>[+local|+dirty]
 * package/shepherd=<rev>[+local|+dirty] source=sha256:<hex>`
 */
export function v2VersionLine(
	agentId: string,
	captured: CapturedBuildStamp,
): string {
	const origins = Array.isArray(captured.provenance.origins)
		? captured.provenance.origins
		: [];
	const revisions = origins.map((origin) => {
		const {
			origin: name,
			revision,
			marker,
		} = origin as {
			origin: string;
			revision: string;
			marker?: OriginMarker;
		};
		return `${name}=${revision}${marker ? `+${marker}` : ""}`;
	});
	return [agentId, SOURCE_DOMAIN_V2, ...revisions]
		.join(" ")
		.concat(` source=${captured.manifest.source}`);
}
