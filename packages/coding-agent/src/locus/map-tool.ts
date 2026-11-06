/**
 * locus: `map` tool — ranked repository map, importers and callers.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../tools";
import mapDescription from "./prompts/map.md" with { type: "text" };
import {
	DEFAULT_MAP_BUDGET,
	ensureFresh,
	getRepoIndex,
	type ReconcileResult,
	renderCallers,
	renderImporters,
	renderMap,
	SymbolTargetError,
} from "./repomap";

const mapSchema = type({
	"focus?": type("string").array().describe("paths, globs or path::Symbol to center on"),
	"budget?": type("number").describe(`token budget (default ${DEFAULT_MAP_BUDGET}, 256..8000)`),
	"importers?": type("string").describe("path: list files importing it"),
	"callers?": type("string").describe("path::Symbol: list its callers"),
	"depth?": type("1 | 2").describe("importers/callers: 2 follows one more hop"),
	"include_private?": type("boolean").describe("also list non-exported symbols"),
	"+": "reject",
});

type MapParams = typeof mapSchema.infer;

export interface MapToolDetails {
	mode: "map" | "importers" | "callers";
	files: number;
	indexMs: number;
}

export class MapTool implements AgentTool<typeof mapSchema, MapToolDetails> {
	readonly name = "map";
	readonly approval = "read" as const;
	readonly label = "Map";
	readonly summary = "Ranked repository map, importers and callers";
	readonly description = mapDescription;
	readonly parameters = mapSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: MapParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<MapToolDetails>> {
		if (params.importers && params.callers) throw new ToolError("map: pass either importers or callers, not both");
		const index = await getRepoIndex(this.session.cwd);
		let reconciled: ReconcileResult;
		const started = performance.now();
		try {
			reconciled = await ensureFresh(index, { signal });
		} catch (error) {
			throw new ToolError(`map: indexing failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const depth = params.depth ?? 1;
		let text: string;
		let mode: MapToolDetails["mode"] = "map";
		try {
			if (params.importers) {
				mode = "importers";
				text = renderImporters(index.store, params.importers, depth);
			} else if (params.callers) {
				mode = "callers";
				text = renderCallers(index.store, params.callers, depth);
			} else {
				text = renderMap(index.store, {
					focus: params.focus,
					budget: params.budget,
					includePrivate: params.include_private,
				});
			}
		} catch (error) {
			if (error instanceof SymbolTargetError) throw new ToolError(`map: ${error.message}`);
			throw error;
		}
		return {
			content: [{ type: "text", text }],
			details: {
				mode,
				files: reconciled.graph?.files ?? index.store.allFiles().length,
				// Time this call spent reconciling (0 when a recent pass was reused).
				indexMs: Math.round(performance.now() - started),
			},
		};
	}
}
