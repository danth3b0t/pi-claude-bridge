// Prompt-cache warmth for one pi session, and the "stove" that keeps a known
// 1-hour cache warm while the session sits idle.
//
// Claude Code never reports when a cache entry expires. What it does report, on
// every request's message_start, is how many prompt tokens were read from cache,
// how many were written, and at which lifetime the writes were made. The warmth
// here is an estimate built from that: a request that read or wrote the prefix
// keeps it alive for one lifetime, counted from when the request was sent.
//
// Logging-free and clock-injected, like usage.ts: index.ts wires it to the
// provider and to pi's footer, tests drive it on a fake clock.

import type { query as Query } from "@anthropic-ai/claude-agent-sdk";
import type { McpResult } from "./extract-tool-results.js";
import type { McpToolDef, createToolServer as CreateToolServer } from "./mcp-server.js";
import { MCP_SERVER_NAME } from "./skills.js";
import type { SdkUsage } from "./usage.js";

export type CacheTtl = "1h" | "5m" | "unknown";

const TTL_MS = { "1h": 60 * 60_000, "5m": 5 * 60_000 } as const;

/** How long before the estimated expiry a refresh is launched. An unmeasured
 *  allowance for Claude Code's startup and the network, not a verified figure. */
export const REFRESH_LEAD_MS = 2 * 60_000;

/** A refresh timer that fires later than this past its deadline (the machine
 *  slept, the clock jumped) pauses instead of dispatching. */
export const LATE_TOLERANCE_MS = 30_000;

/** Share of the prompt that must come from cache (read or written) for a request
 *  to confirm the conversation's prefix. Claude Code places its last breakpoint
 *  at the end of the prompt, so only a short tail is ever legitimately uncached. */
export const MIN_CACHED_SHARE = 0.9;

/** A refresh still running this close to the estimated expiry is abandoned:
 *  its request may no longer reach the cache before the entry is gone. */
export const REFRESH_NETWORK_MARGIN_MS = 30_000;

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

/** What the footer shows; null hides both indicators (a model the bridge does not serve). */
export type StoveView = { cache: "hot" | "cold"; stove: "off" | "on" | "paused" } | null;

export interface StoveDeps {
	now: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	render: (view: StoveView) => void;
	/** Why a refresh cannot run right now, or undefined when it can. */
	blocker: () => string | undefined;
	/** Sends one refresh request and resolves with its message_start usage; must
	 *  give up at `deadline` (epoch ms). */
	refresh: (signal: AbortSignal, deadline: number) => Promise<SdkUsage>;
}

type Warmth = { anchor: number; expiresAt: number; ttl: CacheTtl };

/**
 * One session's cache warmth and stove.
 *
 * A single timer is armed for the next instant anything changes: the refresh
 * deadline while the stove can maintain the cache, else the estimated expiry,
 * when the indicator cools. Real requests move both forward. The deadline is
 * re-checked against the wall clock when the timer fires, so a late timer pauses
 * rather than refreshing a cache that may already be gone; nothing is retried.
 */
export class Stove {
	#deps: StoveDeps;
	#enabled = false;
	#supported = false;
	#busy = false;
	#disposed = false;
	#warm: Warmth | null = null;
	/** Why the cache is not known warm, for /stove status. */
	#coldReason = "no request has confirmed a cached prefix yet";
	/** Pauses maintenance until a real request confirms the cache again. */
	#hold: string | undefined;
	#timer: unknown;
	#refresh: AbortController | null = null;
	#refreshDeadline = 0;
	/** Bumped on every cancel, so a refresh that completes late is ignored. */
	#generation = 0;
	#lastView: StoveView | undefined;

	constructor(deps: StoveDeps) {
		this.#deps = deps;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	setEnabled(on: boolean): void {
		this.#enabled = on;
		this.#hold = undefined;
		if (!on) this.#cancelRefresh();
		this.#update();
	}

	setSupported(on: boolean): void {
		this.#supported = on;
		if (!on) this.#cancelRefresh();
		this.#update();
	}

	/** Real work in this session (a pi run). Cancels the refresh and its timer. */
	setBusy(busy: boolean): void {
		this.#busy = busy;
		if (busy) this.#cancelRefresh();
		this.#update();
	}

	/** Usage from a real request, anchored no later than the moment it was sent. */
	recordUsage(usage: SdkUsage, anchor: number): void {
		if (this.#warm && anchor < this.#warm.anchor) return;
		const prior = this.#warm && anchor < this.#warm.expiresAt ? this.#warm.ttl : null;
		const evidence = classifyCacheUsage(usage, prior);
		if (!evidence.confirmed) {
			this.#warm = null;
			this.#coldReason = "the last request did not read or write a cached prefix";
		} else {
			this.#warm = warmth(anchor, evidence.ttl!);
			this.#hold = undefined;
		}
		this.#update();
	}

	/** The next request will not hit the cached prefix (rebuild, model change, ...). */
	invalidate(reason: string): void {
		this.#cancelRefresh();
		this.#warm = null;
		this.#coldReason = `invalidated: ${reason}; waiting for a real request`;
		this.#update();
	}

	describe(): string {
		const now = this.#deps.now();
		const time = (t: number) => new Date(t).toLocaleTimeString();
		const warm = this.#warm && now < this.#warm.expiresAt ? this.#warm : null;
		const cache = warm
			? `cache: warm until ~${time(warm.expiresAt)} (${warm.ttl === "1h" ? "1 hour" : warm.ttl === "5m" ? "5 minute" : "unknown, counted as 5 minute"} lifetime)`
			: `cache: not known warm — ${this.#coldReason}`;
		const pause = this.#pauseReason();
		const stove = !this.#enabled ? "stove: off"
			: this.#refresh ? "stove: on — refreshing"
			: pause ? `stove: paused — ${pause}`
			: `stove: on — next refresh ~${time(this.#warm!.expiresAt - REFRESH_LEAD_MS)}`;
		return [cache, stove,
			"Cache expiry is estimated from the last request."].join("\n");
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancelRefresh();
		this.#arm(undefined);
	}

	#pauseReason(): string | undefined {
		if (this.#hold) return this.#hold;
		if (!this.#warm) return this.#coldReason;
		if (this.#warm.ttl === "5m") return "the cache lifetime is 5 minutes; only a 1 hour cache is maintained";
		if (this.#warm.ttl === "unknown") return "the cache lifetime is not known to be 1 hour";
		return undefined;
	}

	#update(): void {
		if (this.#disposed) return;
		const now = this.#deps.now();
		if (this.#warm && now >= this.#warm.expiresAt) {
			this.#warm = null;
			this.#coldReason = "the estimated lifetime has passed";
		}
		if (this.#refresh && now >= this.#refreshDeadline) {
			this.#cancelRefresh();
			this.#hold = "the last refresh did not finish before its deadline";
		}
		let wakeAt = this.#refresh ? this.#refreshDeadline : this.#warm?.expiresAt;
		const maintaining = this.#enabled && this.#supported && !this.#busy && !this.#refresh && this.#pauseReason() === undefined;
		if (maintaining) {
			const refreshAt = this.#warm!.expiresAt - REFRESH_LEAD_MS;
			if (now < refreshAt) {
				wakeAt = refreshAt;
			} else if (now - refreshAt > LATE_TOLERANCE_MS) {
				this.#hold = "the refresh deadline was missed (the machine may have slept)";
			} else {
				const blocker = this.#deps.blocker();
				if (blocker) this.#hold = `could not refresh: ${blocker}`;
				else {
					this.#dispatch(now);
					wakeAt = this.#refreshDeadline;
				}
			}
		}
		this.#arm(wakeAt);
		this.#render(now);
	}

	#dispatch(launchedAt: number): void {
		const controller = new AbortController();
		this.#refresh = controller;
		this.#refreshDeadline = this.#warm!.expiresAt - REFRESH_NETWORK_MARGIN_MS;
		const generation = ++this.#generation;
		this.#deps.refresh(controller.signal, this.#refreshDeadline).then(
			(usage) => this.#settle(generation, () => this.#refreshed(usage, launchedAt)),
			(error) => this.#settle(generation, () => { this.#hold = `the last refresh failed: ${error instanceof Error ? error.message : String(error)}`; }),
		);
	}

	#settle(generation: number, apply: () => void): void {
		if (generation !== this.#generation || this.#disposed) return;
		this.#refresh = null;
		apply();
		this.#update();
	}

	/** A refresh is a request like any other, except that it must hit: a miss has
	 *  already paid for rewriting the whole prefix, and repeating it would pay again. */
	#refreshed(usage: SdkUsage, launchedAt: number): void {
		const evidence = classifyCacheUsage(usage, this.#warm?.ttl ?? null);
		if (!evidence.confirmed) {
			this.#hold = "the last refresh did not confirm the cache";
			return;
		}
		this.#warm = warmth(launchedAt, evidence.ttl!);
		if (evidence.readShare < MIN_CACHED_SHARE) this.#hold = "the last refresh missed the cache and rewrote it";
	}

	#cancelRefresh(): void {
		this.#generation++;
		this.#refresh?.abort();
		this.#refresh = null;
	}

	#arm(at: number | undefined): void {
		if (this.#timer !== undefined) this.#deps.clearTimer(this.#timer);
		this.#timer = undefined;
		if (at === undefined || this.#disposed) return;
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = undefined;
			this.#update();
		}, Math.max(0, at - this.#deps.now()));
	}

	#render(now: number): void {
		const view: StoveView = this.#supported
			? { cache: this.#warm && now < this.#warm.expiresAt ? "hot" : "cold", stove: !this.#enabled ? "off" : this.#pauseReason() && !this.#refresh ? "paused" : "on" }
			: null;
		if (JSON.stringify(view) === JSON.stringify(this.#lastView)) return;
		this.#lastView = view;
		this.#deps.render(view);
	}
}

function warmth(anchor: number, ttl: CacheTtl): Warmth {
	return { anchor, expiresAt: anchor + TTL_MS[ttl === "1h" ? "1h" : "5m"], ttl };
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
