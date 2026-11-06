/**
 * locus: `edit_symbol` planning — resolve `path::Qual.Name` targets in the
 * current text of a file and compute the edited text. Pure: no I/O.
 *
 * Contract:
 * - Targets resolve against the given text (never a cached index): exactly one
 *   candidate applies; zero or several fail with the candidates listed.
 * - A symbol's range includes its doc comment, decorators and attributes.
 * - Inserted/replacement code is re-indented to the target's indentation.
 * - All ops resolve before any applies; overlapping ops fail; ops apply
 *   bottom-up so offsets stay valid. All or nothing.
 * - A result that turns an error-free file into one with syntax errors fails.
 */
import { extractTags, type FileTags, type SymbolTag } from "@oh-my-pi/pi-natives";
import { closestNames } from "../repomap/render";

export type SymbolOpKind = "replace" | "insert_before" | "insert_after" | "delete";

export interface SymbolOp {
	op: SymbolOpKind;
	/** `path::Qual.Name`, optionally `Type<Trait>.method` and/or `#N`. */
	target: string;
	code?: string;
}

export interface ParsedTarget {
	file: string;
	qname: string;
	/** Rust trait of an `impl Trait for Type` member. */
	trait: string | null;
	/** 1-based ordinal among candidates. */
	ordinal: number | null;
}

export class SymbolEditError extends Error {}

/** Line span (1-based, inclusive) of a changed region in the edited text. */
export interface ChangedSpan {
	target: string;
	op: SymbolOpKind;
	startLine: number;
	endLine: number;
}

export interface SymbolEditPlan {
	text: string;
	spans: ChangedSpan[];
	/** Removed regions, reported against the original text. */
	deleted: Array<{ target: string; startLine: number; endLine: number }>;
}

/** Parse `path::A.B[#N]` / `path::Type<Trait>.method` (also `A::B` member separators). */
export function parseSymbolTarget(target: string): ParsedTarget {
	const sep = target.indexOf("::");
	if (sep <= 0 || sep === target.length - 2) {
		throw new SymbolEditError(`invalid target "${target}": expected path::Name or path::Class.method`);
	}
	const file = target.slice(0, sep).replace(/^\.\//, "");
	let rest = target.slice(sep + 2);
	let ordinal: number | null = null;
	const ord = /#(\d+)$/.exec(rest);
	if (ord) {
		ordinal = Number(ord[1]);
		rest = rest.slice(0, ord.index);
	}
	let trait: string | null = null;
	const tr = /^([^<.]+)<([^>]+)>\./.exec(rest);
	if (tr) {
		trait = tr[2]!.trim();
		rest = `${tr[1]}.${rest.slice(tr[0].length)}`;
	}
	const qname = rest.replaceAll("::", ".");
	if (!qname || ordinal === 0) throw new SymbolEditError(`invalid target "${target}"`);
	return { file, qname, trait, ordinal };
}

function lineSpanLabel(s: SymbolTag): string {
	return s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`;
}

/** Resolve one target to exactly one symbol of `tags`, or throw with candidates. */
export function resolveInTags(tags: FileTags, target: string): SymbolTag {
	const parsed = parseSymbolTarget(target);
	let candidates = tags.symbols.filter(s => s.qname === parsed.qname);
	if (parsed.trait !== null) candidates = candidates.filter(s => s.detail === parsed.trait);
	if (parsed.ordinal !== null) {
		const hit = candidates[parsed.ordinal - 1];
		if (hit) return hit;
	} else if (candidates.length === 1) {
		return candidates[0]!;
	}
	if (candidates.length > 0) {
		const list = candidates.map((s, i) => {
			const trait = s.detail ? `<${s.detail}>` : "";
			const base = trait
				? `${s.qname.slice(0, s.qname.lastIndexOf("."))}${trait}${s.qname.slice(s.qname.lastIndexOf("."))}`
				: s.qname;
			return `  ${parsed.file}::${base}#${i + 1}  ${s.kind}  ${lineSpanLabel(s)}  ${s.signature}`;
		});
		const why = parsed.ordinal !== null ? `has no candidate #${parsed.ordinal}` : "is ambiguous";
		throw new SymbolEditError(
			`"${target}" ${why} (${candidates.length} candidates):\n${list.join("\n")}\nUse a qualified target or #N.`,
		);
	}
	const close = closestNames(parsed.qname, [...new Set(tags.symbols.map(s => s.qname))], 5);
	throw new SymbolEditError(`symbol not found "${target}".${close.length > 0 ? ` Closest: ${close.join(", ")}` : ""}`);
}

// ── Text helpers ────────────────────────────────────────────────────────

interface Lines {
	lines: string[];
	/** Original text ended with a newline. */
	trailingNewline: boolean;
}

function splitLines(text: string): Lines {
	const trailingNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (trailingNewline) lines.pop();
	return { lines, trailingNewline };
}

function leadingWhitespace(line: string): string {
	return /^[ \t]*/.exec(line)?.[0] ?? "";
}

function isBlank(line: string | undefined): boolean {
	return line === undefined || line.trim() === "";
}

/** Strip the common indentation of `code`, then indent every non-blank line with `indent`. */
export function reindent(code: string, indent: string): string[] {
	const lines = code.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	while (lines.length > 0 && isBlank(lines[0])) lines.shift();
	let common: string | null = null;
	for (const line of lines) {
		if (isBlank(line)) continue;
		const ws = leadingWhitespace(line);
		if (common === null || ws.length < common.length) common = ws;
	}
	const strip = common?.length ?? 0;
	return lines.map(line => (isBlank(line) ? "" : indent + line.slice(strip)));
}

interface Resolved {
	op: SymbolOp;
	sym: SymbolTag;
	/** 0-based inclusive line indexes the symbol occupies. */
	first: number;
	last: number;
	indent: string;
}

/** Plan all ops on one file. Throws {@link SymbolEditError} on any failure. */
export function planSymbolEdits(code: string, filePath: string, ops: SymbolOp[]): SymbolEditPlan {
	const before = extractTags({ code, path: filePath });
	if (!before.supported) {
		throw new SymbolEditError(
			`edit_symbol supports TS/JS, Go and Rust files; ${filePath} is ${before.language ?? "an unknown language"}. Use edit instead.`,
		);
	}
	const { lines, trailingNewline } = splitLines(code);
	const bytes = new TextEncoder().encode(code);
	const decoder = new TextDecoder();
	const lineStarts = [0];
	for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lineStarts.push(i + 1);

	const resolved: Resolved[] = ops.map(op => {
		if (op.op !== "delete" && (op.code === undefined || op.code.trim() === "")) {
			throw new SymbolEditError(`${op.op} on "${op.target}" needs non-empty code`);
		}
		const sym = resolveInTags(before, op.target);
		const first = sym.startLine - 1;
		const last = sym.endLine - 1;
		// Line-granular edits need the symbol to own its lines: only whitespace
		// before it, only whitespace or a line comment after it.
		const lineStart = lineStarts[first] ?? 0;
		const lineEnd = (lineStarts[last + 1] ?? bytes.length + 1) - 1;
		const prefix = decoder.decode(bytes.subarray(lineStart, sym.startByte));
		const suffix = decoder.decode(bytes.subarray(Math.min(sym.endByte, lineEnd), Math.max(sym.endByte, lineEnd)));
		const suffixOk = suffix.trim() === "" || /^\s*(\/\/|#)/.test(suffix);
		if (prefix.trim() !== "" || !suffixOk) {
			const line = prefix.trim() !== "" ? sym.startLine : sym.endLine;
			throw new SymbolEditError(`"${op.target}" shares line ${line} with other code; use edit for this change`);
		}
		return { op, sym, first, last, indent: leadingWhitespace(lines[first] ?? "") };
	});

	// Overlap check: replace/delete ranges must be disjoint, and no other op
	// may target a symbol inside a replaced/deleted one.
	const sorted = [...resolved].sort((a, b) => a.first - b.first || a.last - b.last);
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			const a = sorted[i]!;
			const b = sorted[j]!;
			if (b.first > a.last) break;
			const destructive = (r: Resolved) => r.op.op === "replace" || r.op.op === "delete";
			const sameTarget = a.sym.startByte === b.sym.startByte && a.sym.endByte === b.sym.endByte;
			if (sameTarget && !destructive(a) && !destructive(b)) continue;
			if (destructive(a) || destructive(b)) {
				throw new SymbolEditError(
					`ops on "${a.op.target}" and "${b.op.target}" overlap; split them into separate calls`,
				);
			}
		}
	}

	// Apply bottom-up. Each op is a splice of whole lines.
	interface Splice {
		at: number;
		remove: number;
		insert: string[];
		r: Resolved;
	}
	const splices: Splice[] = resolved.map(r => {
		const body = r.op.code === undefined ? [] : reindent(r.op.code, r.indent);
		switch (r.op.op) {
			case "replace":
				return { at: r.first, remove: r.last - r.first + 1, insert: body, r };
			case "delete":
				return { at: r.first, remove: r.last - r.first + 1, insert: [], r };
			case "insert_before": {
				const sep = isBlank(lines[r.first - 1]) || isBlank(lines[r.last + 1]) ? [""] : [];
				return { at: r.first, remove: 0, insert: [...body, ...sep], r };
			}
			case "insert_after": {
				const sep = isBlank(lines[r.last + 1]) || isBlank(lines[r.first - 1]) ? [""] : [];
				return { at: r.last + 1, remove: 0, insert: [...sep, ...body], r };
			}
		}
	});
	// Bottom-up; at the same anchor, later ops in the call land first so the
	// final order matches the call order.
	const order = splices
		.map((s, i) => ({ s, i }))
		.sort((a, b) => b.s.at - a.s.at || b.i - a.i)
		.map(x => x.s);

	const out = [...lines];
	const deleted: SymbolEditPlan["deleted"] = [];
	for (const s of order) {
		out.splice(s.at, s.remove, ...s.insert);
		if (s.r.op.op === "delete") {
			deleted.push({ target: s.r.op.target, startLine: s.r.sym.startLine, endLine: s.r.sym.endLine });
			// Collapse the blank lines left on both sides of the hole into one.
			while (isBlank(out[s.at - 1]) && isBlank(out[s.at]) && s.at < out.length && s.at > 0) out.splice(s.at, 1);
			if (s.at === 0) while (out.length > 0 && isBlank(out[0])) out.shift();
		}
	}

	// Changed spans in the new text: recompute by replaying offsets top-down.
	const spans: ChangedSpan[] = [];
	const topDown = [...splices].sort((a, b) => a.at - b.at);
	let shift = 0;
	for (const s of topDown) {
		if (s.r.op.op !== "delete" && s.insert.length > 0) {
			const firstContent = s.insert.findIndex(l => l !== "");
			const lastContent = s.insert.length - 1 - [...s.insert].reverse().findIndex(l => l !== "");
			spans.push({
				target: s.r.op.target,
				op: s.r.op.op,
				startLine: s.at + shift + firstContent + 1,
				endLine: s.at + shift + lastContent + 1,
			});
		}
		shift += s.insert.length - s.remove;
	}

	const text = out.join("\n") + (trailingNewline && out.length > 0 ? "\n" : "");
	const after = extractTags({ code: text, path: filePath });
	if (!before.hasErrors && after.hasErrors) {
		throw new SymbolEditError(
			"edit_symbol: the result has syntax errors, nothing was written. Check brackets and that `code` is one complete declaration.",
		);
	}
	return { text, spans, deleted };
}
