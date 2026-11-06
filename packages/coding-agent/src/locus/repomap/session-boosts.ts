/**
 * locus: personalization from the session's own activity.
 *
 * Scans the tool calls still in the model's context for file paths: files the
 * agent edited weigh more than files it read. Recent calls weigh more than old
 * ones. Paths come from tool arguments only (`path`, `paths`, hashline
 * `[path#TAG]` headers, apply-patch `*** Update File:` lines, `edit_symbol`
 * targets), so nothing is guessed from prose.
 */
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";

export const EDITED_BOOST = 5;
export const READ_BOOST = 3;
/** Tool calls considered, newest first. */
const MAX_CALLS = 60;

const EDIT_TOOLS = new Set(["edit", "write", "edit_symbol", "ast_edit"]);
const READ_TOOLS = new Set(["read", "map"]);

const HASHLINE_HEADER = /^\[([^\]\r\n#]+)#[0-9A-F]{4}\]$/gm;
const PATCH_FILE = /^\*\*\* (?:Update|Add) File: (.+)$/gm;

function pathsFromArgs(name: string, args: Record<string, unknown>): string[] {
	const out: string[] = [];
	const add = (v: unknown) => {
		if (typeof v === "string" && v.length > 0 && v.length < 1024) out.push(v);
	};
	add(args.path);
	if (Array.isArray(args.paths)) args.paths.forEach(add);
	if (name === "map" && Array.isArray(args.focus)) args.focus.forEach(add);
	if (typeof args.input === "string") {
		for (const m of args.input.matchAll(HASHLINE_HEADER)) add(m[1]);
		for (const m of args.input.matchAll(PATCH_FILE)) add(m[1]?.trim());
	}
	if (Array.isArray(args.ops)) {
		for (const op of args.ops) {
			const target = (op as { target?: unknown } | null)?.target;
			if (typeof target === "string") add(target);
		}
	}
	// `path::Symbol` targets and `path:12-40` selectors name the file before the separator.
	return out.map(p => p.replace(/::.*$/, "").replace(/:\d[\d,-]*$/, ""));
}

/**
 * Boosts by repo-relative path. `toRelative` maps a tool-argument path to a
 * repo-relative indexed path, or `null` to drop it (outside the repo, URL).
 */
export function collectSessionBoosts(
	messages: readonly Message[],
	toRelative: (p: string) => string | null,
): Map<string, number> {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (block.type === "toolCall") calls.push({ name: block.name, args: block.arguments });
		}
	}
	const boosts = new Map<string, number>();
	const recent = calls.slice(-MAX_CALLS).reverse();
	recent.forEach((call, age) => {
		const kind = EDIT_TOOLS.has(call.name) ? EDITED_BOOST : READ_TOOLS.has(call.name) ? READ_BOOST : 0;
		if (kind === 0) return;
		// Newest call keeps the full boost; the oldest considered keeps a third.
		const decay = 1 - (2 / 3) * (age / MAX_CALLS);
		for (const raw of pathsFromArgs(call.name, call.args)) {
			const rel = toRelative(raw);
			if (rel === null) continue;
			boosts.set(rel, Math.max(boosts.get(rel) ?? 0, kind * decay));
		}
	});
	return boosts;
}

/** `toRelative` for a session: resolve against cwd, keep paths under `root`. */
export function repoRelative(root: string, cwd: string): (p: string) => string | null {
	return p => {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;
		const abs = path.resolve(cwd, p);
		const rel = path.relative(root, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
		return rel.split(path.sep).join("/");
	};
}
