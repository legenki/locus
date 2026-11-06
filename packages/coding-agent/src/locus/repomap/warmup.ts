/**
 * locus: index warmup and the static map for the system prompt.
 *
 * - `warmRepoIndex` starts a background reconcile when a session's tools are
 *   built, so the first `map` call rarely waits for a cold index. It never
 *   throws and is skipped under `bun test` (tests build tools by the
 *   hundreds) and when `LOCUS_REPOMAP=off`.
 * - `staticRepoMapForPrompt` returns a small global map from the index as it
 *   already is on disk — it never indexes, so session start never waits. The
 *   text is fixed per root for the process lifetime: a system prompt rebuilt
 *   mid-session keeps the same bytes and the provider's prompt cache. Disable
 *   with `LOCUS_REPOMAP_INJECT=off`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/test-runtime";
import { ensureFresh, findRepoRoot, getRepoIndex } from "./registry";
import { renderMap } from "./render";
import type { IndexStore } from "./store";

export const STATIC_MAP_BUDGET = 1000;
const STATIC_MAP_META = "static_map";

const promptMaps = new Map<string, string>();

function disabled(name: string): boolean {
	const v = Bun.env[name]?.toLowerCase();
	return v === "off" || v === "0" || v === "false";
}

export function isRepoMapEnabled(): boolean {
	return !disabled("LOCUS_REPOMAP");
}

/** Render (or reuse) the static map for the index's current graph version. */
export function cachedStaticMap(store: IndexStore): string {
	const version = store.getMeta("graph_built_at");
	if (!version) return "";
	const cached = store.getMeta(STATIC_MAP_META);
	if (cached) {
		try {
			const parsed = JSON.parse(cached) as { version: string; text: string };
			if (parsed.version === version) return parsed.text;
		} catch {
			// Rebuild below.
		}
	}
	const text = renderMap(store, { budget: STATIC_MAP_BUDGET });
	store.setMeta(STATIC_MAP_META, JSON.stringify({ version, text }));
	return text;
}

export function warmRepoIndex(cwd: string): void {
	if (!isRepoMapEnabled() || isBunTestRuntime()) return;
	void (async () => {
		try {
			const index = await getRepoIndex(cwd);
			await ensureFresh(index);
			// Pre-render for the next session's prompt.
			cachedStaticMap(index.store);
		} catch (error) {
			logger.debug("locus: index warmup failed", { cwd, error: String(error) });
		}
	})();
}

export async function staticRepoMapForPrompt(cwd: string): Promise<string> {
	if (!isRepoMapEnabled() || disabled("LOCUS_REPOMAP_INJECT") || isBunTestRuntime()) return "";
	try {
		const root = await findRepoRoot(cwd);
		const known = promptMaps.get(root);
		if (known !== undefined) return known;
		const index = await getRepoIndex(cwd);
		const text = cachedStaticMap(index.store);
		promptMaps.set(root, text);
		return text;
	} catch (error) {
		logger.debug("locus: static map unavailable", { cwd, error: String(error) });
		return "";
	}
}
