/**
 * locus: `edit_symbol` — replace / insert / delete whole symbols by name.
 *
 * Planning is pure ({@link planSymbolEdits}); writing goes through the
 * built-in `write` tool so approval tiers, plan-mode guards, LSP format and
 * diagnostics, the ACP editor bridge and checkpoints behave exactly as for
 * any other write. The current text is read through the ACP bridge when one
 * is attached (the editor buffer is the source of truth), else from disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { extractTags } from "@oh-my-pi/pi-natives";
import { formatHashlineHeader, formatNumberedLines } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import { getEditStore } from "../../edit/store";
import { normalizeToLF } from "../../edit/normalize";
import { InternalUrlRouter } from "../../internal-urls";
import type { ToolSession } from "../../tools";
import { strictestApproval, truncateForPrompt } from "../../tools/approval";
import { approvalTargetKey } from "../../tools/approval-targets";
import { formatPathRelativeToCwd } from "../../tools/path-utils";
import { routeReadThroughBridge } from "../../tools/read-summary";
import { WriteTool } from "../../tools/write";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import editSymbolDescription from "../prompts/edit-symbol.md" with { type: "text" };
import { findRepoRoot, invalidateRepoIndex } from "../repomap/registry";
import { type ChangedSpan, parseSymbolTarget, planSymbolEdits, type SymbolOp, SymbolEditError } from "./plan";

/** Changed lines shown (and marked seen for hashline) per symbol. */
const MAX_SHOWN_LINES = 120;

const opSchema = type({
	op: type("'replace' | 'insert_before' | 'insert_after' | 'delete'"),
	target: type("string").describe("path::Name, path::Class.method, path::Type<Trait>.method, optional #N"),
	"code?": type("string").describe("new declaration (replace/insert); omit for delete"),
	"+": "reject",
});

const editSymbolSchema = type({
	ops: opSchema.array().atLeastLength(1).describe("applied together, all or none"),
	"+": "reject",
});

type EditSymbolParams = typeof editSymbolSchema.infer;

export interface EditSymbolDetails {
	files: Array<{ path: string; ops: number; resolvedPath: string }>;
}

function targetFiles(args: unknown): string[] {
	const ops = (args as Partial<EditSymbolParams> | null | undefined)?.ops;
	if (!Array.isArray(ops)) return [];
	const files = new Set<string>();
	for (const op of ops) {
		if (typeof op?.target !== "string") continue;
		const sep = op.target.indexOf("::");
		if (sep > 0) files.add(op.target.slice(0, sep));
	}
	return [...files];
}

export class EditSymbolTool implements AgentTool<typeof editSymbolSchema, EditSymbolDetails> {
	readonly name = "edit_symbol";
	readonly label = "Edit Symbol";
	readonly summary = "Replace, insert or delete whole symbols by name";
	readonly description = editSymbolDescription;
	readonly parameters = editSymbolSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";

	readonly approval = (args: unknown): ToolApprovalDecision => {
		const files = targetFiles(args);
		if (files.length === 0) return "write";
		return strictestApproval(files.map(f => InternalUrlRouter.instance().writeTier(f, undefined, this.session)));
	};

	readonly approvalCacheTargets = (args: unknown): readonly string[] | undefined => {
		const keys = targetFiles(args).flatMap(f => approvalTargetKey(this.session.cwd, f) ?? []);
		return keys.length > 0 ? keys : undefined;
	};

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const ops = (args as Partial<EditSymbolParams>).ops ?? [];
		return ops.map(op => `${op.op} ${op.target}${op.code === undefined ? "" : `:\n${truncateForPrompt(op.code)}`}`);
	};

	#write: WriteTool;

	constructor(private readonly session: ToolSession) {
		this.#write = new WriteTool(session);
	}

	/** Resolve a target path against the session cwd, then the repository root. */
	async #resolvePath(rel: string): Promise<string> {
		if (path.isAbsolute(rel)) return rel;
		const fromCwd = path.resolve(this.session.cwd, rel);
		try {
			await fs.stat(fromCwd);
			return fromCwd;
		} catch {
			const fromRoot = path.resolve(await findRepoRoot(this.session.cwd), rel);
			try {
				await fs.stat(fromRoot);
				return fromRoot;
			} catch {
				throw new ToolError(`edit_symbol: file not found: ${rel}`);
			}
		}
	}

	async #readCurrent(absolutePath: string): Promise<string> {
		const bridged = routeReadThroughBridge(this.session, absolutePath);
		if (bridged !== undefined) {
			try {
				return await bridged;
			} catch (error) {
				logger.warn("edit_symbol: ACP readTextFile failed; falling back to disk", { path: absolutePath, error });
			}
		}
		return Bun.file(absolutePath).text();
	}

	async execute(
		toolCallId: string,
		params: EditSymbolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditSymbolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditSymbolDetails>> {
		// Group by file, keeping call order inside each file.
		const byFile = new Map<string, SymbolOp[]>();
		for (const op of params.ops) {
			let file: string;
			try {
				file = parseSymbolTarget(op.target).file;
			} catch (error) {
				throw new ToolError(`edit_symbol: ${(error as Error).message}`);
			}
			const list = byFile.get(file);
			if (list) list.push(op);
			else byFile.set(file, [op]);
		}

		// Plan every file before writing any: a bad target anywhere writes nothing.
		const planned: Array<{
			rel: string;
			abs: string;
			ops: SymbolOp[];
			text: string;
			spans: ChangedSpan[];
			deleted: string[];
		}> = [];
		for (const [rel, ops] of byFile) {
			const abs = await this.#resolvePath(rel);
			const current = normalizeToLF(await this.#readCurrent(abs));
			try {
				const plan = planSymbolEdits(current, abs, ops);
				planned.push({
					rel,
					abs,
					ops,
					text: plan.text,
					spans: plan.spans,
					deleted: plan.deleted.map(d => `${d.target} (was L${d.startLine}-${d.endLine})`),
				});
			} catch (error) {
				if (error instanceof SymbolEditError) throw new ToolError(`edit_symbol: ${error.message}`);
				throw error;
			}
		}

		const blocks: string[] = [];
		const details: EditSymbolDetails = { files: [] };
		for (const p of planned) {
			const result = await this.#write.execute(
				`${toolCallId}:${p.rel}`,
				{ path: p.abs, content: p.text },
				signal,
				undefined,
				context,
			);
			invalidateRepoIndex(p.abs);
			details.files.push({ path: p.rel, ops: p.ops.length, resolvedPath: p.abs });
			const writeText = result.content.flatMap(c => (c.type === "text" ? [c.text] : [])).join("\n");
			blocks.push(await this.#describe(p, writeText));
			onUpdate?.({ content: [{ type: "text", text: blocks.join("\n\n") }], details });
		}
		return { content: [{ type: "text", text: blocks.join("\n\n") }], details };
	}

	/**
	 * Show changed symbols as numbered lines under a fresh `[path#TAG]` header
	 * and record those rows as seen, so a hashline edit inside them needs no
	 * re-read. When the LSP formatter reshaped the file, spans are re-located by
	 * name; anything unlocatable is reported without line numbers.
	 */
	async #describe(
		p: { rel: string; abs: string; text: string; spans: ChangedSpan[]; deleted: string[] },
		writeText: string,
	): Promise<string> {
		const finalText = normalizeToLF(await this.#readCurrent(p.abs));
		let spans = p.spans;
		if (finalText !== p.text) {
			const tags = extractTags({ code: finalText, path: p.abs });
			spans = p.spans.flatMap(s => {
				const firstLine = p.text.split("\n")[s.startLine - 1]?.trim() ?? "";
				const hit = tags.symbols.find(sym => finalText.split("\n")[sym.nameLine - 1]?.trim() === firstLine);
				return hit ? [{ ...s, startLine: hit.startLine, endLine: hit.endLine }] : [];
			});
		}
		const lines = finalText.split("\n");
		const out: string[] = [];
		const summary = [...p.spans.map(s => `${s.op} ${s.target}`), ...p.deleted.map(d => `delete ${d}`)];
		out.push(`edit_symbol: ${summary.join("; ")}`);

		const hashLines = resolveFileDisplayMode(this.session).hashLines;
		const bodies: string[] = [];
		for (const s of spans) {
			const end = Math.min(s.endLine, s.startLine + MAX_SHOWN_LINES - 1);
			const slice = lines.slice(s.startLine - 1, end).join("\n");
			bodies.push(hashLines ? formatNumberedLines(slice, s.startLine) : slice);
			if (end < s.endLine) bodies.push(`… ${s.endLine - end} more lines (read ${p.rel}:${end + 1}-${s.endLine})`);
		}
		if (hashLines && spans.length > 0) {
			const store = getEditStore(this.session);
			const tag = store.recordSnapshot(p.abs, finalText, []);
			store.recordSeenLinesFromBody(p.abs, tag, bodies.join("\n"));
			out.push(formatHashlineHeader(formatPathRelativeToCwd(p.abs, this.session.cwd), tag));
		}
		out.push(...bodies);
		if (spans.length < p.spans.length) out.push("(the formatter reshaped the file; read it before line edits)");
		// Keep the write tool's own report (diagnostics, notes) minus its header/size line.
		const extra = writeText
			.split("\n")
			.filter(l => !/^\[.*#[0-9A-F]{4}\]$/.test(l) && !l.startsWith("Successfully wrote "))
			.join("\n")
			.trim();
		if (extra) out.push(extra);
		return out.join("\n");
	}
}
