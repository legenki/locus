/**
 * locus: SQLite store for the repository index.
 *
 * One database per repository root under `~/.omp/locus/index/<hash>.db`. The
 * store is a cache: a corrupt file is moved aside and rebuilt, and a schema
 * version bump drops every table.
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir, openSqliteDatabaseSync } from "@oh-my-pi/pi-utils";
import type { FileTags } from "@oh-my-pi/pi-natives";

/** Bump when the schema or the meaning of stored tags changes. */
export const INDEX_SCHEMA_VERSION = 1;

export interface FileRow {
	id: number;
	path: string;
	lang: string | null;
	size: number;
	mtime_ms: number;
	content_hash: string;
	line_count: number;
	pagerank: number;
}

export interface SymbolRow {
	id: number;
	file_id: number;
	name: string;
	qname: string;
	kind: string;
	start_line: number;
	end_line: number;
	name_line: number;
	exported: number;
	signature: string;
	parent_id: number | null;
	detail: string | null;
}

export interface ImportRow {
	id: number;
	file_id: number;
	specifier: string;
	kind: string;
	/** JSON array of `{ imported, local }`. */
	names: string;
	alias: string | null;
	line: number;
	resolved_file_id: number | null;
	/** JSON array of extra file ids for package-level imports (Go). */
	resolved_extra: string | null;
}

export interface RefRow {
	file_id: number;
	enclosing_symbol_id: number | null;
	name: string;
	qualifier: string | null;
	kind: string;
	line: number;
	count: number;
}

export interface EdgeRow {
	src_file: number;
	dst_file: number;
	weight: number;
	kind: string;
}

export interface CallRow {
	caller_symbol_id: number | null;
	caller_file_id: number;
	callee_symbol_id: number;
	callee_file_id: number;
	count: number;
	confidence: "import" | "local" | "unique";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL UNIQUE,
	lang TEXT,
	size INTEGER NOT NULL,
	mtime_ms REAL NOT NULL,
	content_hash TEXT NOT NULL,
	line_count INTEGER NOT NULL DEFAULT 0,
	has_errors INTEGER NOT NULL DEFAULT 0,
	pagerank REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	qname TEXT NOT NULL,
	kind TEXT NOT NULL,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	name_line INTEGER NOT NULL,
	exported INTEGER NOT NULL,
	signature TEXT NOT NULL,
	parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
	detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qname);
-- Foreign-key children need an index on the referencing column, or every
-- deleted parent row scans the child table (18 s → 8 ms re-indexing one file).
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
CREATE TABLE IF NOT EXISTS imports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	specifier TEXT NOT NULL,
	kind TEXT NOT NULL,
	names TEXT NOT NULL,
	alias TEXT,
	line INTEGER NOT NULL,
	resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
	resolved_extra TEXT
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_file_id);
CREATE TABLE IF NOT EXISTS refs (
	file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	enclosing_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	qualifier TEXT,
	kind TEXT NOT NULL,
	line INTEGER NOT NULL,
	count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_enclosing ON refs(enclosing_symbol_id);
CREATE TABLE IF NOT EXISTS edges (
	src_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	dst_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	weight REAL NOT NULL,
	kind TEXT NOT NULL,
	PRIMARY KEY (src_file, dst_file, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_file);
CREATE TABLE IF NOT EXISTS calls (
	caller_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
	caller_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	callee_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
	callee_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	count INTEGER NOT NULL,
	confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller_file ON calls(caller_file_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee_file ON calls(callee_file_id);
`;

const TABLES = ["calls", "edges", "refs", "imports", "symbols", "files", "meta"] as const;

/** Directory holding per-repository index databases. */
export function getIndexDir(): string {
	return path.join(getConfigRootDir(), "locus", "index");
}

/** Database path for a repository root. */
export function getIndexDbPath(root: string): string {
	const digest = Bun.hash(path.resolve(root)).toString(16).padStart(16, "0");
	return path.join(getIndexDir(), `${path.basename(root) || "root"}-${digest}.db`);
}

export class IndexStore {
	readonly db: Database;
	#insertFile: Statement;
	#updateFileMeta: Statement;
	#insertSymbol: Statement;
	#insertImport: Statement;
	#insertRef: Statement;

	constructor(db: Database) {
		this.db = db;
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("PRAGMA foreign_keys = ON");
		db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
		if (version && Number(version.value) !== INDEX_SCHEMA_VERSION) {
			for (const table of TABLES) db.run(`DROP TABLE IF EXISTS ${table}`);
		}
		db.run(SCHEMA);
		db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)", [String(INDEX_SCHEMA_VERSION)]);

		this.#insertFile = db.prepare(
			"INSERT INTO files (path, lang, size, mtime_ms, content_hash, line_count, has_errors) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.#updateFileMeta = db.prepare("UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?");
		this.#insertSymbol = db.prepare(
			"INSERT INTO symbols (file_id, name, qname, kind, start_line, end_line, name_line, exported, signature, parent_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#insertImport = db.prepare(
			"INSERT INTO imports (file_id, specifier, kind, names, alias, line) VALUES (?, ?, ?, ?, ?, ?)",
		);
		this.#insertRef = db.prepare(
			"INSERT INTO refs (file_id, enclosing_symbol_id, name, qualifier, kind, line, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
	}

	/** Open (creating or recovering) the index for `root`. */
	static open(root: string, dbPath = getIndexDbPath(root)): IndexStore {
		// SQLite creates the file, not its directory (`~/.omp/locus/index/` on first use).
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(dbPath, db => new IndexStore(db), { recoverCorruption: true });
	}

	close(): void {
		this.db.close();
	}

	getMeta(key: string): string | null {
		return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
	}

	setMeta(key: string, value: string): void {
		this.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", [key, value]);
	}

	allFiles(): FileRow[] {
		return this.db
			.query<FileRow, []>(
				"SELECT id, path, lang, size, mtime_ms, content_hash, line_count, pagerank FROM files ORDER BY path",
			)
			.all();
	}

	fileByPath(relPath: string): FileRow | null {
		return this.db
			.query<FileRow, [string]>(
				"SELECT id, path, lang, size, mtime_ms, content_hash, line_count, pagerank FROM files WHERE path = ?",
			)
			.get(relPath);
	}

	touchFile(id: number, size: number, mtimeMs: number): void {
		this.#updateFileMeta.run(size, mtimeMs, id);
	}

	deleteFile(relPath: string): void {
		this.db.run("DELETE FROM files WHERE path = ?", [relPath]);
	}

	/**
	 * Replace everything stored for `relPath` with freshly extracted tags.
	 * Imports land unresolved; the graph rebuild resolves them.
	 */
	replaceFile(relPath: string, stat: { size: number; mtimeMs: number }, hash: string, tags: FileTags): number {
		// Keep the file id stable: other files' resolved imports point at it.
		const existing = this.db.query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?").get(relPath);
		let fileId: number;
		if (existing) {
			fileId = existing.id;
			this.db.run(
				"UPDATE files SET lang = ?, size = ?, mtime_ms = ?, content_hash = ?, line_count = ?, has_errors = ? WHERE id = ?",
				[tags.language ?? null, stat.size, stat.mtimeMs, hash, tags.lineCount, tags.hasErrors ? 1 : 0, fileId],
			);
			for (const table of ["refs", "imports", "symbols"])
				this.db.run(`DELETE FROM ${table} WHERE file_id = ?`, [fileId]);
		} else {
			fileId = Number(
				this.#insertFile.run(
					relPath,
					tags.language ?? null,
					stat.size,
					stat.mtimeMs,
					hash,
					tags.lineCount,
					tags.hasErrors ? 1 : 0,
				).lastInsertRowid,
			);
		}
		const symbolIds: number[] = [];
		for (const s of tags.symbols) {
			const parent = s.parent === undefined || s.parent === null ? null : (symbolIds[s.parent] ?? null);
			const id = this.#insertSymbol.run(
				fileId,
				s.name,
				s.qname,
				s.kind,
				s.startLine,
				s.endLine,
				s.nameLine,
				s.exported ? 1 : 0,
				s.signature,
				parent,
				s.detail ?? null,
			).lastInsertRowid;
			symbolIds.push(Number(id));
		}
		for (const i of tags.imports) {
			this.#insertImport.run(fileId, i.specifier, i.kind, JSON.stringify(i.names), i.alias ?? null, i.line);
		}
		for (const r of tags.refs) {
			const enclosing = r.enclosing === undefined || r.enclosing === null ? null : (symbolIds[r.enclosing] ?? null);
			this.#insertRef.run(fileId, enclosing, r.name, r.qualifier ?? null, r.kind, r.line, r.count);
		}
		return fileId;
	}

	/**
	 * Files whose graph resolution may depend on `fileIds`: the files
	 * themselves, files that import them (directly or through up to three
	 * re-export hops), and files whose calls landed in them.
	 */
	dependentsOf(fileIds: Iterable<number>): Set<number> {
		const out = new Set<number>(fileIds);
		let frontier = [...out];
		const importersQ = this.db.query<{ file_id: number; kind: string }, [string]>(
			`SELECT DISTINCT file_id, kind FROM imports WHERE resolved_file_id IN (SELECT value FROM json_each(?1))
			 OR (resolved_extra IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(resolved_extra) e WHERE e.value IN (SELECT value FROM json_each(?1))))`,
		);
		const callersQ = this.db.query<{ caller_file_id: number }, [string]>(
			"SELECT DISTINCT caller_file_id FROM calls WHERE callee_file_id IN (SELECT value FROM json_each(?))",
		);
		for (const r of callersQ.all(JSON.stringify(frontier))) out.add(r.caller_file_id);
		for (let hop = 0; hop < 4 && frontier.length > 0; hop++) {
			const next: number[] = [];
			for (const r of importersQ.all(JSON.stringify(frontier))) {
				if (!out.has(r.file_id)) {
					out.add(r.file_id);
					// Only re-exporters pass dependence further up.
					if (r.kind === "reexport") next.push(r.file_id);
				} else if (r.kind === "reexport" && hop === 0) next.push(r.file_id);
			}
			frontier = next;
		}
		return out;
	}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}
}
