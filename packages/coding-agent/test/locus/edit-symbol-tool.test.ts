import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { EditSymbolTool } from "@oh-my-pi/pi-coding-agent/locus/edit-symbol/tool";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.flatMap(b => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
}

const SOURCE = `export class Store {
  get(id: string): string {
    return id;
  }

  put(id: string): void {}
}

export function helper(): number {
  return 1;
}
`;

describe("edit_symbol tool", () => {
	let dir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-symbol-tool-"));
		await Bun.write(path.join(dir, "store.ts"), SOURCE);
		await Bun.write(path.join(dir, "other.ts"), SOURCE);
	});
	afterEach(async () => {
		await removeWithRetries(dir);
	});

	// The handoff contract: the result's header + numbered lines are enough for a
	// hashline edit inside the new body, with no `read` in between.
	it("replaces a method and hands off to hashline without a re-read", async () => {
		const session = createSession(dir);
		const result = await new EditSymbolTool(session).execute("c1", {
			ops: [
				{
					op: "replace",
					target: "store.ts::Store.get",
					code: "get(id: string): string {\n  const key = id.trim();\n  return key;\n}",
				},
			],
		});
		const out = text(result);
		const header = out.split("\n").find(l => /^\[store\.ts#[0-9A-F]{4}\]$/.test(l));
		expect(header).toBeDefined();
		expect(out).toContain("2:  get(id: string): string {");
		expect(out).toContain("3:    const key = id.trim();");

		await new EditTool(session, "hashline").execute("c2", {
			input: `${header}\nPUT 3-3:\n+    const key = id.trim().toLowerCase();\n`,
		});
		const final = await Bun.file(path.join(dir, "store.ts")).text();
		expect(final).toContain(
			"  get(id: string): string {\n    const key = id.trim().toLowerCase();\n    return key;\n  }\n\n  put(",
		);
	});

	it("writes nothing anywhere when any target fails", async () => {
		const session = createSession(dir);
		const call = new EditSymbolTool(session).execute("c1", {
			ops: [
				{ op: "delete", target: "store.ts::helper" },
				{ op: "delete", target: "other.ts::Store.missing" },
			],
		});
		await expect(call).rejects.toThrow(/symbol not found "other\.ts::Store\.missing"/);
		expect(await Bun.file(path.join(dir, "store.ts")).text()).toBe(SOURCE);
		expect(await Bun.file(path.join(dir, "other.ts")).text()).toBe(SOURCE);
	});

	// In Zed the open buffer is the truth: unsaved edits are planned against and
	// the write goes back through the editor, not around it.
	it("plans against the editor buffer and writes through the ACP bridge", async () => {
		const buffer = SOURCE.replace("return 1;", "return 2; // unsaved");
		const writes: Array<{ path: string; content: string }> = [];
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true, writeTextFile: true },
			readTextFile: async () => buffer,
			writeTextFile: async params => {
				writes.push(params);
			},
		} as ClientBridge;
		const session = createSession(dir, bridge);
		await new EditSymbolTool(session).execute("c1", {
			ops: [{ op: "insert_after", target: "store.ts::helper", code: "export function extra(): void {}" }],
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]!.path).toBe(path.join(dir, "store.ts"));
		expect(writes[0]!.content).toContain("return 2; // unsaved");
		expect(writes[0]!.content).toContain("}\n\nexport function extra(): void {}\n");
		expect(await Bun.file(path.join(dir, "store.ts")).text()).toBe(SOURCE);
	});
});
