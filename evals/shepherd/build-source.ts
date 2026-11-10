/**
 * The build identity and compiler the evals use: the evals' only import of
 * them, from `scripts/eval-source.ts`.
 */

export {
	type Builder,
	type BuildProvenance,
	compareUtf8,
	compileAgent,
	createGitRunner,
	entryPackagePath,
	framedDigest,
	GATED_MODULES,
	type GitRunner,
	gitStamp,
	IDENTITY_MODULE,
	isSourcePath,
	type ManifestEntry,
	RECORDS_UNTRACKED,
	readWorktreeSource,
	runGit,
	SHEPHERD_ID,
	ShepherdSourceError,
	type SourceFile,
	type SourceLayout,
	type SourceManifest,
	type StampSource,
	sameSource,
	versionLine,
} from "../../scripts/eval-source";
