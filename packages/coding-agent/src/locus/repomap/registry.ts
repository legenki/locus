/**
 * locus: process-wide registry of open repository indexes, one per root.
 *
 * `ensureFresh()` reconciles at most once per {@link RECONCILE_INTERVAL_MS}
 * unless forced; tools call it before every query so manual edits, branch
 * switches and other processes' writes are picked up without a watcher.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { type ReconcileResult, RepoIndex } from "./repo-index";

export const RECONCILE_INTERVAL_MS = 3000;

interface Entry {
	index: RepoIndex;
	lastReconcile: number;
	last: ReconcileResult | null;
}

const entries = new Map<string, Entry>();

/** Nearest ancestor of `cwd` (inclusive) that holds `.git`; `cwd` otherwise. */
export async function findRepoRoot(cwd: string): Promise<string> {
	let dir = path.resolve(cwd);
	while (true) {
		try {
			await fs.stat(path.join(dir, ".git"));
			return dir;
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) return path.resolve(cwd);
			dir = parent;
		}
	}
}

export async function getRepoIndex(cwd: string): Promise<RepoIndex> {
	const root = await findRepoRoot(cwd);
	let entry = entries.get(root);
	if (!entry) {
		entry = { index: RepoIndex.open(root), lastReconcile: 0, last: null };
		entries.set(root, entry);
	}
	return entry.index;
}

/** Reconcile `index` if the last pass is older than the interval (or `force`). */
export async function ensureFresh(index: RepoIndex, options: { force?: boolean; signal?: AbortSignal } = {}) {
	const entry = entries.get(index.root);
	const now = Date.now();
	if (entry && !options.force && now - entry.lastReconcile < RECONCILE_INTERVAL_MS && entry.last) return entry.last;
	const result = await index.reconcile(options.signal);
	if (entry) {
		entry.lastReconcile = Date.now();
		entry.last = result;
	}
	return result;
}

/** Mark files written by this process so the next query reconciles. */
export function invalidateRepoIndex(absPath: string): void {
	for (const [root, entry] of entries) {
		if (absPath === root || absPath.startsWith(`${root}${path.sep}`)) entry.lastReconcile = 0;
	}
}

export function closeAllRepoIndexes(): void {
	for (const entry of entries.values()) {
		try {
			entry.index.close();
		} catch (error) {
			logger.debug("locus: closing index failed", { root: entry.index.root, error: String(error) });
		}
	}
	entries.clear();
}
