import { describe, expect, test } from "bun:test";
import { planSymbolEdits, type SymbolOp } from "../../src/locus/edit-symbol/plan";

const TS = `import { http } from "./http";

export class UserStore {
  /** Load one user. */
  @Cached()
  async fetch(id: string): Promise<User> {
    return http.get(id);
  }

  remove(id: string): void {
    http.delete(id);
  }
}

export function legacy(): void {}

export function keep(): void {}
`;

const plan = (code: string, path: string, ...ops: SymbolOp[]) => planSymbolEdits(code, path, ops);

describe("edit_symbol planning", () => {
	// The model writes code without nesting; the method lands at member depth,
	// and the doc comment + decorator (part of the range) are replaced with it.
	test("replace re-indents code to the target and covers docs and decorators", () => {
		const out = plan(TS, "s.ts", {
			op: "replace",
			target: "s.ts::UserStore.fetch",
			code: "async fetch(id: string): Promise<User> {\n  return http.get(id, { cache: true });\n}",
		});
		expect(out.text).toContain(
			"export class UserStore {\n  async fetch(id: string): Promise<User> {\n    return http.get(id, { cache: true });\n  }\n\n  remove(",
		);
		expect(out.text).not.toContain("@Cached()");
		expect(out.spans).toEqual([{ target: "s.ts::UserStore.fetch", op: "replace", startLine: 4, endLine: 6 }]);
	});

	test("insert_after keeps the blank-line style between siblings and reports its span", () => {
		const out = plan(TS, "s.ts", {
			op: "insert_after",
			target: "s.ts::UserStore.remove",
			code: "    clear(): void {\n      http.reset();\n    }",
		});
		expect(out.text).toContain("    http.delete(id);\n  }\n\n  clear(): void {\n    http.reset();\n  }\n}");
		const span = out.spans[0]!;
		expect(out.text.split("\n").slice(span.startLine - 1, span.endLine)).toEqual([
			"  clear(): void {",
			"    http.reset();",
			"  }",
		]);
	});

	test("delete collapses the surrounding blank lines into one", () => {
		const out = plan(TS, "s.ts", { op: "delete", target: "s.ts::legacy" });
		expect(out.text).toContain("}\n\nexport function keep(): void {}\n");
		expect(out.text).not.toContain("legacy");
		expect(out.deleted).toEqual([{ target: "s.ts::legacy", startLine: 15, endLine: 15 }]);
	});

	// Ops resolve against the original text; spans are reported in the new one.
	test("several ops apply bottom-up with spans in final coordinates", () => {
		const out = plan(
			TS,
			"s.ts",
			{ op: "insert_before", target: "s.ts::UserStore", code: "export const VERSION = 2;" },
			{ op: "replace", target: "s.ts::keep", code: "export function keep(): number {\n  return 1;\n}" },
		);
		const lines = out.text.split("\n");
		for (const s of out.spans) expect(lines[s.startLine - 1]).toMatch(/^export (const VERSION|function keep)/);
		expect(lines[out.spans[1]!.endLine - 1]).toBe("}");
	});

	test("ambiguous overloads fail with numbered candidates; #N picks one", () => {
		const code =
			"export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: unknown) {\n  return a;\n}\n";
		expect(() => plan(code, "f.ts", { op: "delete", target: "f.ts::f" })).toThrow(
			/is ambiguous \(3 candidates\):\n {2}f\.ts::f#1 {2}function {2}L1/,
		);
		const out = plan(code, "f.ts", {
			op: "replace",
			target: "f.ts::f#3",
			code: "export function f(a: unknown) {\n  return String(a);\n}",
		});
		expect(out.text).toContain("return String(a);");
		expect(out.text.match(/export function f\(a: (string|number)\): void;/g)).toHaveLength(2);
	});

	test("Rust: Type<Trait>.method selects the trait impl member", () => {
		const code = `pub struct Node;

impl Node {
    fn fmt(&self) -> String { String::new() }
}

impl std::fmt::Display for Node {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "node")
    }
}
`;
		expect(() => plan(code, "n.rs", { op: "delete", target: "n.rs::Node.fmt" })).toThrow(/Node<Display>\.fmt#2/);
		const out = plan(code, "n.rs", {
			op: "replace",
			target: "n.rs::Node<Display>.fmt",
			code: 'fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {\n    write!(f, "Node")\n}',
		});
		expect(out.text).toContain("    fn fmt(&self) -> String { String::new() }\n}");
		expect(out.text).toContain('        write!(f, "Node")');
	});

	test("unknown targets suggest the closest names", () => {
		expect(() => plan(TS, "s.ts", { op: "delete", target: "s.ts::UserStore.fetc" })).toThrow(
			/Closest: UserStore\.fetch/,
		);
	});

	test("rejects results that introduce syntax errors, overlapping ops, and shared lines", () => {
		expect(() => plan(TS, "s.ts", { op: "replace", target: "s.ts::keep", code: "export function keep( {" })).toThrow(
			/syntax errors, nothing was written/,
		);
		expect(() =>
			plan(
				TS,
				"s.ts",
				{ op: "delete", target: "s.ts::UserStore" },
				{ op: "replace", target: "s.ts::UserStore.remove", code: "remove() {}" },
			),
		).toThrow(/overlap/);
		expect(() => plan("const a = 1; const b = 2;\n", "x.ts", { op: "delete", target: "x.ts::a" })).toThrow(
			/shares line 1 with other code/,
		);
	});

	test("unsupported languages point to edit", () => {
		expect(() => plan("def f():\n  pass\n", "a.py", { op: "delete", target: "a.py::f" })).toThrow(/Use edit instead/);
	});
});
