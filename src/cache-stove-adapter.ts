// The Claude bridge's adapter for the cache-stove extension (~/.pi/agent/extensions/cache-stove).
//
// Claude Code never reports when a cache entry expires. What it does report, on
// every request's message_start, is how many prompt tokens were read from cache,
// how many were written, and at which lifetime the writes were made. This module
// turns that into the normalized evidence the stove consumes — a conservative
// expiry and whether a refresh may maintain it — and sends the refresh itself.
// The stove owns timing; the lifetimes and the refresh transport are Claude's.

import type { query as Query } from "@anthropic-ai/claude-agent-sdk";
import type { McpResult } from "./extract-tool-results.js";
import type { McpToolDef, createToolServer as CreateToolServer } from "./mcp-server.js";
import { MCP_SERVER_NAME } from "./skills.js";
import type { SdkUsage } from "./usage.js";

export type CacheTtl = "1h" | "5m" | "unknown";

const TTL_MS = { "1h": 60 * 60_000, "5m": 5 * 60_000 } as const;

/** The pi.events contract, version 1 (see protocol.ts in the cache-stove extension). */
export const CACHE_STOVE = {
	version: 1,
	adapter: "claude-bridge",
	discover: "cache-stove:v1:discover",
	register: "cache-stove:v1:register",
	evidence: "cache-stove:v1:evidence",
	invalidate: "cache-stove:v1:invalidate",
} as const;

/** Share of the prompt that must come from cache (read or written) for a request
 *  to confirm the conversation's prefix. Claude Code places its last breakpoint
 *  at the end of the prompt, so only a short tail is ever legitimately uncached. */
export const MIN_CACHED_SHARE = 0.9;

/**
 * What one request's usage proves about the cached prefix.
 *
 * `priorTtl` is the lifetime already known for the prefix this request read, or
 * null when nothing is known about it. A read never reveals the lifetime of the
 * entry it hit, and new writes at 1h say nothing about the entries before them,
 * so a read of an unknown prefix stays unknown. Mixed lifetimes resolve to the
 * shortest: 5m is the floor, so a 5m write is known even next to an unknown read.
 */
export function classifyCacheUsage(usage: SdkUsage, priorTtl: CacheTtl | null): { confirmed: boolean; ttl?: CacheTtl; readShare: number } {
	const input = usage.input_tokens ?? 0;
	const read = usage.cache_read_input_tokens ?? 0;
	const write = usage.cache_creation_input_tokens ?? 0;
	const total = input + read + write;
	const readShare = total > 0 ? read / total : 0;
	if (total === 0 || (read + write) / total < MIN_CACHED_SHARE) return { confirmed: false, readShare };
	const lifetimes: CacheTtl[] = [];
	if (read > 0) lifetimes.push(priorTtl ?? "unknown");
	if (write > 0) lifetimes.push(writeTtl(usage, write));
	const ttl = lifetimes.includes("5m") ? "5m" : lifetimes.includes("unknown") ? "unknown" : "1h";
	return { confirmed: true, ttl, readShare };
}

function writeTtl(usage: SdkUsage, write: number): CacheTtl {
	const breakdown = usage.cache_creation;
	if (!breakdown) return "unknown";
	if ((breakdown.ephemeral_5m_input_tokens ?? 0) > 0) return "5m";
	return breakdown.ephemeral_1h_input_tokens === write ? "1h" : "unknown";
}

/** What the bridge knows about one session's cached prefix. */
export type KnownCache = { anchor: number; expiresAt: number; ttl: CacheTtl };

/** The normalized part of a cache-stove evidence report. */
export type CacheEstimate = { expiresAt: number | null; maintain: boolean; reason?: string };

/**
 * One request's usage as the stove sees it, and what the bridge now knows.
 *
 * Only a known 1 hour cache is maintained; anything else is shown warm for the
 * 5 minute floor. A refresh must also have read the prefix: a miss already paid
 * for rewriting it, and maintaining that would pay again at every deadline.
 */
export function estimateCache(usage: SdkUsage, known: KnownCache | null, anchor: number, refresh = false): { known: KnownCache | null; estimate: CacheEstimate } {
	const prior = known && anchor < known.expiresAt ? known.ttl : null;
	const evidence = classifyCacheUsage(usage, prior);
	if (!evidence.confirmed) {
		const reason = refresh ? "the last refresh did not confirm the cache" : "the last request did not read or write a cached prefix";
		// A refresh that confirms nothing leaves what real requests established.
		return { known: refresh ? known : null, estimate: { expiresAt: null, maintain: false, reason } };
	}
	const ttl = evidence.ttl!;
	const next = { anchor, expiresAt: anchor + TTL_MS[ttl === "1h" ? "1h" : "5m"], ttl };
	const reason = ttl === "5m" ? "the cache lifetime is 5 minutes; only a 1 hour cache is maintained"
		: ttl === "unknown" ? "the cache lifetime is not known to be 1 hour"
		: refresh && evidence.readShare < MIN_CACHED_SHARE ? "the last refresh missed the cache and rewrote it"
		: undefined;
	return { known: next, estimate: { expiresAt: next.expiresAt, maintain: reason === undefined, ...(reason ? { reason } : {}) } };
}

/** A real query's options and served tools, captured so a refresh can repeat the
 *  request prefix exactly. `options` excludes resume and the MCP server instance. */
export interface RefreshRecipe {
	options: Record<string, unknown>;
	tools: Array<Omit<McpToolDef, "handler">>;
}

const REFRESH_PROMPT = "[Prompt cache refresh. Do not use tools. Reply with only: OK]";

const REFUSED: McpResult = { content: [{ type: "text", text: "Tool use is disabled during a prompt cache refresh." }], isError: true };

/**
 * One refresh request: a resumed, forked, non-persisted copy of the session's
 * Claude Code conversation, with the real query's options and tool declarations
 * and a short new prompt. Resolves with the usage of the first main-thread
 * request and closes the child there; tool calls are answered with a refusal.
 * Gives up, closing the child, at `deadline` or at Claude Code's first API retry
 * (a retried request may arrive after the entry expired and rewrite it cold).
 * Closing the child does not guarantee the upstream request is cancelled, and
 * retries Claude Code makes without reporting api_retry are not detected.
 *
 * diag/probe-stove-refresh.mjs checks cache reuse beyond the original expiry,
 * session-file isolation, and tool refusal. Exact wire-prefix identity and
 * output billed after the early close require separate measurement.
 */
export async function runRefresh(args: {
	query: typeof Query;
	createToolServer: typeof CreateToolServer;
	recipe: RefreshRecipe;
	resume: string;
	signal: AbortSignal;
	deadline: number;
}): Promise<SdkUsage> {
	const { query, createToolServer, recipe, resume, signal, deadline } = args;
	// Rechecked here, after whatever the caller awaited: nothing spawns once cancelled or late.
	signal.throwIfAborted();
	if (Date.now() >= deadline) throw new Error("refresh deadline passed before launch");
	const tools = recipe.tools.map((tool) => ({ ...tool, handler: async () => REFUSED }));
	const child = query({
		prompt: REFRESH_PROMPT,
		options: {
			...recipe.options,
			resume,
			forkSession: true,
			persistSession: false,
			maxTurns: 1,
			...(tools.length ? { mcpServers: { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, tools) } } : {}),
		},
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("refresh cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => reject(new Error("refresh deadline passed")), deadline - Date.now());
	});
	try {
		return await Promise.race([firstRequestUsage(child), cancelled]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		void child.interrupt().catch(() => {});
		try { child.close(); } catch {}
	}
}

async function firstRequestUsage(child: ReturnType<typeof Query>): Promise<SdkUsage> {
	for await (const message of child) {
		if (message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_start") {
			return message.event.message.usage as SdkUsage;
		}
		if (message.type === "system" && message.subtype === "api_retry") {
			throw new Error(`Claude Code is retrying the refresh request (status ${message.error_status ?? "none"}); stopped`);
		}
		if (message.type === "result") {
			const failure = message as { result?: string; errors?: string[]; subtype: string };
			throw new Error(`Claude Code ended the refresh before any request: ${failure.result || failure.errors?.join("; ") || failure.subtype}`);
		}
	}
	throw new Error("Claude Code ended the refresh before any request");
}
