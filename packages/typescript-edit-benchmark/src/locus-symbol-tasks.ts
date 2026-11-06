/**
 * locus: generate whole-symbol edit tasks from the benchmark's own fixtures.
 *
 * The stock fixtures are small in-body mutations (operator swaps, moved
 * blocks). These tasks cover what `edit_symbol` is for — changing a whole
 * function or method — so the two edit strategies can be compared where each
 * is supposed to win. Each task starts from a fixture's `expected/` file (real
 * omp source) and asks for one of:
 *
 * - `symbol-replace`: replace a function/method with a given implementation
 *   (a local renamed throughout plus a new first body line), so the change
 *   spans the whole body;
 * - `symbol-delete`: delete a function/method with its doc comment;
 * - `symbol-insert`: add a given method/function directly after one.
 *
 * Output uses the stock fixture layout (prompt.md, input/, expected/,
 * metadata.json). Every expected file is checked to parse and to differ from
 * its input.
 *
 * Usage: bun src/locus-symbol-tasks.ts --source <fixtures dir> --out <dir> [--count 24]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { extractTags, type SymbolTag } from "@oh-my-pi/pi-natives";

type Kind = "replace" | "delete" | "insert";

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		out: { type: "string" },
		count: { type: "string", default: "24" },
	},
});
if (!values.source || !values.out) {
	process.stderr.write("usage: bun src/locus-symbol-tasks.ts --source <fixtures dir> --out <dir> [--count 24]\n");
	process.exit(2);
}
const total = Number(values.count);
// Half replace (the core case), a quarter each delete and insert.
const plan: Kind[] = Array.from({ length: total }, (_, i) =>
	i % 4 < 2 ? "replace" : i % 4 === 2 ? "delete" : "insert",
);

function isCandidate(s: SymbolTag, all: SymbolTag[]): boolean {
	if (s.kind !== "function" && s.kind !== "method") return false;
	const lines = s.endLine - s.startLine + 1;
	if (lines < 6 || lines > 40) return false;
	return all.filter(o => o.qname === s.qname).length === 1;
}

/** Rename a local declared in the symbol (`const|let name`) throughout it. */
function renameLocal(text: string): { text: string; from: string; to: string } | null {
	const decls = [...text.matchAll(/\b(?:const|let)\s+([a-zA-Z_$][\w$]{2,})\b/g)].map(m => m[1]!);
	for (const name of decls) {
		const uses = text.match(new RegExp(`(?<![.\\w$])${name}(?![\\w$])`, "g"))?.length ?? 0;
		if (uses < 2) continue;
		const to = `${name}Next`;
		if (text.includes(to)) continue;
		return { text: text.replace(new RegExp(`(?<![.\\w$])${name}(?![\\w$])`, "g"), to), from: name, to };
	}
	return null;
}

/** Add a comment as the first line of the body (after the opening `{` line). */
function addFirstBodyLine(text: string): string | null {
	const lines = text.split("\n");
	const open = lines.findIndex(l => l.trimEnd().endsWith("{"));
	if (open < 0 || open === lines.length - 1) return null;
	const indent = /^\s*/.exec(lines[open + 1] ?? "")?.[0] ?? "";
	lines.splice(open + 1, 0, `${indent}// Normalized by the locus refactor.`);
	return lines.join("\n");
}

function describe(s: SymbolTag): string {
	const dot = s.qname.lastIndexOf(".");
	return dot < 0 ? `function \`${s.name}\`` : `method \`${s.name}\` of \`${s.qname.slice(0, dot)}\``;
}

async function main(): Promise<void> {
	const source = values.source!;
	const out = values.out!;
	await fs.rm(out, { recursive: true, force: true });
	const fixtures = (await fs.readdir(source)).sort();
	const usedFiles = new Set<string>();
	let made = 0;

	for (const fixture of fixtures) {
		if (made >= plan.length) break;
		const metadata = (await Bun.file(path.join(source, fixture, "metadata.json")).json()) as { file_path: string };
		const fileName = path.basename(metadata.file_path);
		if (usedFiles.has(fileName) || !/\.(ts|tsx)$/.test(fileName)) continue;
		const base = await Bun.file(path.join(source, fixture, "expected", fileName)).text();
		const tags = extractTags({ code: base, path: fileName });
		if (tags.hasErrors) continue;
		const candidates = tags.symbols.filter(s => isCandidate(s, tags.symbols));
		if (candidates.length === 0) continue;
		const kind = plan[made]!;
		// Deterministic pick: the middle candidate.
		const sym = candidates[Math.floor(candidates.length / 2)]!;
		const lines = base.split("\n");
		const symText = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
		let expected: string;
		let prompt: string;
		const target = describe(sym);

		if (kind === "replace") {
			const renamed = renameLocal(symText);
			const changed = renamed ? addFirstBodyLine(renamed.text) : null;
			if (!changed) continue;
			expected = [...lines.slice(0, sym.startLine - 1), changed, ...lines.slice(sym.endLine)].join("\n");
			prompt = `# Replace ${target} in \`${fileName}\`

Replace the whole ${target} in \`${fileName}\` (lines ${sym.startLine}-${sym.endLine}, including its doc comment and decorators, if any) with exactly this code:

\`\`\`ts
${changed}
\`\`\`

Do not modify anything else.`;
		} else if (kind === "delete") {
			expected = [...lines.slice(0, sym.startLine - 1), ...lines.slice(sym.endLine)].join("\n");
			prompt = `# Delete ${target} from \`${fileName}\`

Delete the ${target} from \`${fileName}\` entirely, together with its doc comment and decorators, if any. It currently starts with:

\`\`\`ts
${lines[sym.nameLine - 1]!.trim()}
\`\`\`

Do not modify anything else.`;
		} else {
			const isMethod = sym.qname.includes(".");
			const indent = /^\s*/.exec(lines[sym.startLine - 1] ?? "")?.[0] ?? "";
			const name = `${sym.name}Snapshot`;
			if (tags.symbols.some(s => s.name === name)) continue;
			const added = isMethod
				? `${indent}${name}(): string {\n${indent}  return JSON.stringify({ name: "${sym.name}" });\n${indent}}`
				: `${indent}export function ${name}(): string {\n${indent}  return JSON.stringify({ name: "${sym.name}" });\n${indent}}`;
			expected = [...lines.slice(0, sym.endLine), "", added, ...lines.slice(sym.endLine)].join("\n");
			prompt = `# Add a ${isMethod ? "method" : "function"} after ${target} in \`${fileName}\`

Add this ${isMethod ? "method" : "function"} directly after the ${target} in \`${fileName}\`, separated by a blank line:

\`\`\`ts
${added
	.split("\n")
	.map(l => l.slice(indent.length))
	.join("\n")}
\`\`\`

Do not modify anything else.`;
		}

		if (expected === base) continue;
		if (extractTags({ code: expected, path: fileName }).hasErrors) continue;

		const id = `symbol-${kind}-${String(made + 1).padStart(3, "0")}`;
		const dir = path.join(out, id);
		await Bun.write(path.join(dir, "input", fileName), base);
		await Bun.write(path.join(dir, "expected", fileName), expected);
		await Bun.write(path.join(dir, "prompt.md"), `${prompt}\n`);
		await Bun.write(
			path.join(dir, "metadata.json"),
			`${JSON.stringify(
				{
					mutation_type: `symbol-${kind}`,
					mutation_category: "symbol",
					difficulty: "medium",
					line_number: sym.startLine,
					file_path: metadata.file_path,
					original_snippet: lines[sym.nameLine - 1]!.trim(),
					source_fixture: fixture,
					target: `${fileName}::${sym.qname}`,
				},
				null,
				2,
			)}\n`,
		);
		usedFiles.add(fileName);
		made++;
	}
	process.stdout.write(`generated ${made} tasks in ${out}\n`);
}

await main();
