/**
 * locus: repository index orchestration.
 *
 * `reconcile()` brings the index in line with the working tree:
 *
 * 1. List files (gitignore-aware) with size and mtime.
 * 2. Unchanged `(size, mtime)` → skip. Otherwise hash the content; an equal
 *    hash only refreshes the stat (checkout, touch). A new hash re-extracts
 *    tags. Files gone from the tree are dropped.
 * 3. When anything changed, rebuild the graph from stored tags and re-rank.
 *
 * A content hash backs the stat check, so a `git checkout` that restores old
 * mtimes or sizes still re-indexes what actually changed.
 */
import * as path from "node:path";
import { extractTagsAsync, type FileTags, FileType, glob } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { type GraphStats, rebuildGraph } from "./graph";
import { loadProjectConfig, PROJECT_CONFIG_FILES, type ProjectConfig } from "./project";
import { IndexStore } from "./store";

/** Extensions with a tags walker. */
export const INDEXED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs"]);

/** Files above this size are skipped (bundles, generated fixtures). */
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;

const PARSE_CONCURRENCY = 8;

/** Above this many modified files, write as we go and rebuild the whole graph. */
const SCOPED_REBUILD_MAX_FILES = 200;

export interface ReconcileResult {
	added: number;
	updated: number;
	removed: number;
	unchanged: number;
	/** Files whose stat changed but content did not. */
	touched: number;
	graph: GraphStats | null;
	durationMs: number;
}

interface PendingWrite {
	file: ListedFile;
	/** Existing file id, `null` for a new file. */
	fileId: number | null;
	hash: string;
	tags: FileTags;
}

interface ListedFile {
	path: string;
	size: number;
	mtimeMs: number;
}

function hashContent(bytes: Uint8Array): string {
	return Bun.hash(bytes).toString(16).padStart(16, "0");
}

export function isIndexable(relPath: string): boolean {
	if (relPath.endsWith(".d.ts") && relPath.includes("node_modules/")) return false;
	return INDEXED_EXTENSIONS.has(path.posix.extname(relPath));
}

export class RepoIndex {
	readonly root: string;
	readonly store: IndexStore;
	#config: ProjectConfig | null = null;
	#configKey = "";
	#running: Promise<ReconcileResult> | null = null;
	#rerun = false;

	constructor(root: string, store: IndexStore) {
		this.root = path.resolve(root);
		this.store = store;
	}

	static open(root: string, dbPath?: string): RepoIndex {
		return new RepoIndex(root, IndexStore.open(root, dbPath));
	}

	close(): void {
		this.store.close();
	}

	get config(): ProjectConfig | null {
		return this.#config;
	}

	/**
	 * Reconcile with the working tree. Concurrent calls share one run; a call
	 * made while a run is in flight schedules exactly one follow-up run.
	 */
	reconcile(signal?: AbortSignal): Promise<ReconcileResult> {
		if (this.#running) {
			this.#rerun = true;
			return this.#running;
		}
		const run = async (): Promise<ReconcileResult> => {
			try {
				let result = await this.#reconcileOnce(signal);
				while (this.#rerun && !signal?.aborted) {
					this.#rerun = false;
					result = await this.#reconcileOnce(signal);
				}
				return result;
			} finally {
				this.#running = null;
			}
		};
		this.#running = run();
		return this.#running;
	}

	async #list(signal?: AbortSignal): Promise<{ code: ListedFile[]; configs: string[] }> {
		const { matches } = await glob({
			pattern: "**/*",
			path: this.root,
			gitignore: true,
			hidden: false,
			fileType: FileType.File,
			cache: false,
			// Only the mtime-sorted walk stats entries; without it `size`/`mtime` are absent.
			sortByMtime: true,
			signal,
		});
		const code: ListedFile[] = [];
		const configs: string[] = [];
		for (const m of matches) {
			const rel = m.path;
			const base = path.posix.basename(rel);
			if (PROJECT_CONFIG_FILES.has(base)) configs.push(rel);
			if (!isIndexable(rel)) continue;
			const size = m.size ?? 0;
			if (size > MAX_INDEXED_FILE_BYTES) continue;
			code.push({ path: rel, size, mtimeMs: m.mtime ?? 0 });
		}
		configs.sort();
		return { code, configs };
	}

	async #reconcileOnce(signal?: AbortSignal): Promise<ReconcileResult> {
		const started = performance.now();
		const { code, configs } = await this.#list(signal);
		const listed = new Map(code.map(f => [f.path, f]));
		const known = new Map(this.store.allFiles().map(f => [f.path, f]));

		const result: ReconcileResult = {
			added: 0,
			updated: 0,
			removed: 0,
			unchanged: 0,
			touched: 0,
			graph: null,
			durationMs: 0,
		};

		const removed = [...known.keys()].filter(p => !listed.has(p));
		if (removed.length > 0) {
			this.store.transaction(() => {
				for (const p of removed) this.store.deleteFile(p);
			});
			result.removed = removed.length;
		}

		const candidates = code.filter(f => {
			const row = known.get(f.path);
			if (row && row.size === f.size && row.mtime_ms === f.mtimeMs) {
				result.unchanged++;
				return false;
			}
			return true;
		});

		// Modified files are held until their dependents are known: writing them
		// cascades away the calls that tell us who depended on them.
		const held: PendingWrite[] = [];
		const holdModified = candidates.filter(f => known.has(f.path)).length <= SCOPED_REBUILD_MAX_FILES;
		let next = 0;
		const worker = async () => {
			while (next < candidates.length) {
				if (signal?.aborted) return;
				const f = candidates[next++];
				if (!f) return;
				const row = known.get(f.path);
				const pending = await this.#parseFile(f, row?.id ?? null, row?.content_hash ?? null, result);
				if (!pending) continue;
				if (pending.fileId !== null && holdModified) held.push(pending);
				else this.#write(pending, result);
			}
		};
		await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker));
		const scope = held.length > 0 ? this.store.dependentsOf(held.map(h => h.fileId!)) : null;
		if (held.length > 0) {
			this.store.transaction(() => {
				for (const h of held) this.#write(h, result);
			});
		}

		const configKey = configs.join("\n");
		const configChanged = configKey !== this.#configKey || this.#config === null;
		const changed = result.added + result.updated + result.removed > 0;
		const neverBuilt = this.store.getMeta("graph_built_at") === null;
		if (configChanged) {
			this.#config = await loadProjectConfig(this.root, configs, new Set(listed.keys()));
			this.#configKey = configKey;
		}
		if ((changed || configChanged || neverBuilt) && !signal?.aborted && this.#config) {
			// A scope reaching a large share of the repo (an edit behind a popular
			// barrel) is cheaper to rebuild whole.
			const tooWide = scope !== null && scope.size > Math.max(SCOPED_REBUILD_MAX_FILES, listed.size * 0.1);
			const full =
				configChanged ||
				neverBuilt ||
				result.added > 0 ||
				result.removed > 0 ||
				!holdModified ||
				scope === null ||
				tooWide;
			result.graph = rebuildGraph(this.store, this.#config, full ? undefined : scope);
			this.store.setMeta("graph_built_at", `${Date.now()}-${crypto.randomUUID()}`);
		}
		result.durationMs = performance.now() - started;
		logger.debug("locus: index reconciled", { root: this.root, ...result });
		return result;
	}

	/** Read and hash a file; parse it if its content changed. */
	async #parseFile(
		f: ListedFile,
		fileId: number | null,
		oldHash: string | null,
		result: ReconcileResult,
	): Promise<PendingWrite | null> {
		const abs = path.join(this.root, f.path);
		let bytes: Uint8Array;
		try {
			bytes = await Bun.file(abs).bytes();
		} catch (error) {
			logger.debug("locus: unreadable file skipped", { path: f.path, error: String(error) });
			return null;
		}
		const hash = hashContent(bytes);
		if (fileId !== null && hash === oldHash) {
			this.store.touchFile(fileId, f.size, f.mtimeMs);
			result.touched++;
			return null;
		}
		const code = new TextDecoder().decode(bytes);
		const tags = await extractTagsAsync({ code, path: f.path });
		return { file: f, fileId, hash, tags };
	}

	#write(p: PendingWrite, result: ReconcileResult): void {
		this.store.transaction(() => this.store.replaceFile(p.file.path, p.file, p.hash, p.tags));
		if (p.fileId !== null) result.updated++;
		else result.added++;
	}
}
