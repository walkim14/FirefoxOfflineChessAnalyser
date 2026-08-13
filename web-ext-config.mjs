/**
 * What actually ships to addons.mozilla.org.
 *
 * Zipping the working tree by hand sweeps in the repository itself, and the
 * AMO validator reads every byte of it: `.git/hooks/*.sample` come back as
 * flagged binaries, the saved chess.com pages under `_external/` as remote
 * scripts, and the test helpers as unsafe dynamic imports — none of which are
 * part of the add-on. Only the directories the manifest actually references
 * belong in the package.
 */
export default {
	// Each directory is named twice: without the glob so the packer never walks
	// into it, and with it so nothing slips through if that ever changes.
	ignoreFiles: [
		"_external",
		"_external/**",
		"docs",
		"docs/**",
		"tests",
		"tests/**",
		"tools",
		"tools/**",
		"node_modules",
		"node_modules/**",
		"package.json",
		"package-lock.json",
		"web-ext-config.mjs",
		"README.md",
	],
	build: {
		overwriteDest: true,
	},
};
