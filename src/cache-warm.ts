// pi's prompt-cache warming: pi's cache warmer, or an extension calling
// modelRegistry.streamSimple the same way, re-sends a session's last request with
// maxTokens: 1 before its cache entry expires. Through the bridge that request
// would start a new turn, so it is answered from a fork of the Claude Code session
// instead: resumed with the turn's own options, never persisted, closed at its
// first request's usage, with every tool refused.

import type { query as Query } from "@anthropic-ai/claude-agent-sdk";
import { compareHistory, type SessionState } from "./session-sync.js";
import type { SdkUsage } from "./usage.js";

export const WARM_PROMPT = "[Prompt cache refresh. Do not use tools. Reply with only: OK]";

/** pi's warm request: its session's last request again, capped at one output token. */
export function isCacheWarm(options: { maxTokens?: number; sessionId?: string } | undefined): boolean {
	return options?.maxTokens === 1 && Boolean(options.sessionId);
}

/**
 * Why a warm of `digests` cannot resume `state`'s Claude Code session, or undefined
 * when it can. The history must be what the session recorded, up to any point: the
 * request pi warms stops before the reply the session went on to record. Anything the
 * next turn would rebuild on refuses, since warming a session it replaces buys nothing.
 */
export function warmRefusal(
	state: SessionState | null,
	digests: string[],
	target: { model: string; promptDigest: string; cwdChanged: boolean },
): string | undefined {
	if (!state) return "no Claude Code session for this pi session";
	if (state.model !== target.model) return "the session was recorded for another model";
	if (state.promptDigest !== target.promptDigest) return "the system prompt changed";
	if (target.cwdChanged) return "the working directory changed";
	if (state.dirtyTail) return "the session's tail differs from pi's history";
	if (!digests.length) return "the request has no history";
	if (compareHistory(digests, state).commonPrefix !== digests.length) return "pi's history differs from the session's";
	return undefined;
}

/** Usage of the child's first main-thread request. Rejects at Claude Code's first API
 *  retry, whose request may arrive after the entry expired and rewrite it cold. */
export async function firstRequestUsage(child: ReturnType<typeof Query>): Promise<SdkUsage> {
	for await (const message of child) {
		if (message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_start") {
			return message.event.message.usage as SdkUsage;
		}
		if (message.type === "system" && message.subtype === "api_retry") {
			throw new Error(`Claude Code is retrying the warm request (status ${message.error_status ?? "none"}); stopped`);
		}
		if (message.type === "result") {
			const failure = message as { result?: string; errors?: string[]; subtype: string };
			throw new Error(`Claude Code ended the warm request before any request: ${failure.result || failure.errors?.join("; ") || failure.subtype}`);
		}
	}
	throw new Error("Claude Code ended the warm request before any request");
}
