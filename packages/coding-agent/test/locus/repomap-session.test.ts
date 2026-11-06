import { describe, expect, test } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { collectSessionBoosts, EDITED_BOOST, READ_BOOST, repoRelative } from "../../src/locus/repomap";

function assistant(...calls: Array<[string, Record<string, unknown>]>): Message {
	return {
		role: "assistant",
		content: calls.map(([name, args], i) => ({ type: "toolCall", id: `c${i}`, name, arguments: args })),
	} as Message;
}

describe("session boosts", () => {
	const toRel = repoRelative("/repo", "/repo/pkg");

	test("edited files outweigh read files; only tool-argument paths count", () => {
		const boosts = collectSessionBoosts(
			[
				assistant(["read", { path: "src/a.ts:10-40" }], ["read", { path: "https://example.com/x.ts" }]),
				assistant(
					["edit", { input: "[src/b.ts#1A2B]\nPUT 3-3:\n+x\n" }],
					["edit_symbol", { ops: [{ op: "delete", target: "src/c.ts::Store.get" }] }],
					["read", { path: "/elsewhere/z.ts" }],
					["bash", { command: "cat src/d.ts" }],
				),
			],
			toRel,
		);
		expect([...boosts.keys()].sort()).toEqual(["pkg/src/a.ts", "pkg/src/b.ts", "pkg/src/c.ts"]);
		expect(boosts.get("pkg/src/b.ts")!).toBeGreaterThan(READ_BOOST);
		expect(boosts.get("pkg/src/c.ts")!).toBeGreaterThan(READ_BOOST);
		expect(boosts.get("pkg/src/c.ts")!).toBeLessThanOrEqual(EDITED_BOOST);
		expect(boosts.get("pkg/src/a.ts")!).toBeLessThanOrEqual(READ_BOOST);
	});

	test("older calls weigh less than recent ones", () => {
		const old = assistant(["read", { path: "old.ts" }]);
		const filler = Array.from({ length: 30 }, () => assistant(["bash", { command: "true" }]));
		const boosts = collectSessionBoosts([old, ...filler, assistant(["read", { path: "new.ts" }])], toRel);
		expect(boosts.get("pkg/new.ts")!).toBeGreaterThan(boosts.get("pkg/old.ts")!);
	});
});
