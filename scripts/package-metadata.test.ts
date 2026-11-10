import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./shepherd-definition";

const pkg = JSON.parse(
	readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
);

describe("the package's dependency metadata", () => {
	test("troupe is requested from GitHub at a full commit", () => {
		expect(pkg.dependencies.troupe).toMatch(
			/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git#[0-9a-f]{40}$/,
		);
	});

	// A dependency's lifecycle scripts run only when the consumer trusts it,
	// and Troupe's root `prepare` is its own Husky setup.
	test("troupe is never a trusted dependency", () => {
		expect(pkg.trustedDependencies ?? []).not.toContain("troupe");
	});

	// C28: Troupe's imports resolve from this package's node_modules, so
	// these pins fix the compiled bytes.
	test("zod and typescript are exact pins", () => {
		expect(pkg.dependencies.zod).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.devDependencies.typescript).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
