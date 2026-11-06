#!/usr/bin/env node
// Does the stove's refresh (src/stove.ts runRefresh) keep a real cache entry alive?
//
// NOT run by any test script. Every phase sends real requests on the logged-in
// Claude account and consumes plan usage; run it only with that budget agreed.
// Synthetic content only: the prompt is filler, and with PROBE_PROXY set,
// diag/capture-proxy.mjs records full request bodies.
//
//   node --import tsx diag/probe-stove-refresh.mjs --i-accept-usage t1      DIR   # T1: establish the cache
//   node --import tsx diag/probe-stove-refresh.mjs --i-accept-usage refresh DIR   # W: ~55 min after T1
//   node --import tsx diag/probe-stove-refresh.mjs --i-accept-usage t2      DIR   # T2: >60 min after T1, <60 after W
//
// What each phase settles:
//   t1      a bridge-shaped request (~25k-token prefix) writes the cache; prints the lifetime split.
//   refresh the fork reads that prefix (read share), leaves the original session file
//           byte-identical, persists no new session file, and never runs a tool.
//   t2      a real resume after T1's entry would have expired still reads the prefix:
//           the refresh renewed it despite closing at message_start.
// Not settled here: output generated after the early close. Compare the proxy's
// captured response stream for the refresh (PROBE_PROXY) against plan usage.
//
// Defaults to the target recipe: what the bridge sends for claude-bridge/claude-opus-5-5
// at thinking level medium on a Max plan (model claude-opus-5-5[1m], effort medium,
// summarized thinking). A pass on any other model or effort (PROBE_MODEL, PROBE_EFFORT)
// says nothing about the target's adaptive thinking or fork behaviour.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";
import { runRefresh } from "../src/stove.ts";
import { createToolServer } from "../src/mcp-server.ts";
import { MCP_SERVER_NAME } from "../src/skills.ts";

const { __test } = await import("../src/index.ts");

const args = process.argv.slice(2);
if (!args.includes("--i-accept-usage")) {
	console.error("Refusing to run: this probe sends real requests. Pass --i-accept-usage once the usage budget is agreed.");
	process.exit(2);
}
const [phase, dir] = args.filter((a) => !a.startsWith("--"));
if (!["t1", "refresh", "t2"].includes(phase) || !dir) {
	console.error("usage: probe-stove-refresh.mjs --i-accept-usage <t1|refresh|t2> DIR");
	process.exit(2);
}
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "probe-state.json");
const MIN = 60_000;

const filler = (n, seed) => Array.from({ length: n },
	(_, i) => `${seed} clause ${i}: the operand must be a well-formed path relative to the workspace root and is validated before dispatch.`).join(" ");
const tools = [0, 1, 2].map((i) => ({
	name: `probe_tool_${i}`,
	description: `Probe tool ${i}. ${filler(30, `t${i}`)}`,
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
}));
// The recipe a bridge turn would record (see streamClaudeAgentSdk's queryOptions).
const options = {
	cwd: dir,
	env: { ...process.env, ...__test.CC_CHILD_ENV, ...(process.env.PROBE_PROXY ? { ANTHROPIC_BASE_URL: process.env.PROBE_PROXY } : {}) },
	tools: [],
	permissionMode: "bypassPermissions",
	includePartialMessages: true,
	settings: { includeGitInstructions: false },
	settingSources: [],
	systemPrompt: { type: "preset", preset: "claude_code", append: `# Probe instructions\n${filler(900, "append")}` },
	effort: process.env.PROBE_EFFORT ?? "medium",
	extraArgs: {
		model: process.env.PROBE_MODEL ?? "claude-opus-5-5[1m]",
		"replay-user-messages": null,
		"strict-mcp-config": null,
		"thinking-display": "summarized",
	},
};
const recipe = { options, tools };
const served = () => ({ [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, tools.map((t) => ({ ...t, handler: async () => ({ content: [{ type: "text", text: "ok" }] }) }))) });

const describe = (u) => {
	const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
	return `in=${u.input_tokens} read=${u.cache_read_input_tokens} write=${u.cache_creation_input_tokens} split=${JSON.stringify(u.cache_creation ?? null)} readShare=${total ? (u.cache_read_input_tokens / total).toFixed(3) : "n/a"}`;
};
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** One real, persisted turn; resolves with its session id and first main-thread usage. */
async function realTurn(prompt, resume) {
	const sentAt = Date.now();
	let sessionId, usage;
	const child = query({ prompt, options: { ...options, maxTurns: 1, mcpServers: served(), ...(resume ? { resume } : {}) } });
	try {
		for await (const m of child) {
			if (m.type === "system" && m.subtype === "api_retry") throw new Error(`stopping on API retry (status ${m.error_status ?? "unknown"})`);
			if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
			if (m.type === "stream_event" && m.parent_tool_use_id === null && m.event.type === "message_start") usage ??= m.event.message.usage;
			if (m.type === "result" && (m.is_error || m.subtype !== "success")) throw new Error(`turn failed: ${m.subtype} ${m.result ?? ""}`);
		}
	} finally {
		child.close();
	}
	if (!sessionId || !usage) throw new Error("turn did not report a session and cache usage");
	return { sessionId, usage, sentAt };
}

if (phase === "t1") {
	const { sessionId, usage, sentAt } = await realTurn("Reply with exactly: OK");
	writeFileSync(statePath, JSON.stringify({ sessionId, t1: sentAt, t1Usage: usage }, null, 2));
	console.log(`T1 session=${sessionId} ${describe(usage)}`);
	console.log(`run "refresh" at ~${new Date(sentAt + 55 * MIN).toLocaleTimeString()} (T1+55m)`);
} else if (phase === "refresh") {
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	const sessionFile = getSessionPath(state.sessionId, dir, process.env.CLAUDE_CONFIG_DIR);
	const before = sha(sessionFile);
	const filesBefore = readdirSync(dirname(sessionFile)).sort();
	let toolCalls = 0;
	const countingServer = (name, defs) => createToolServer(name, defs.map((d) => ({ ...d, handler: async (...a) => { toolCalls++; return d.handler(...a); } })));
	const launchedAt = Date.now();
	const usage = await runRefresh({ query, createToolServer: countingServer, recipe, resume: state.sessionId, signal: new AbortController().signal, deadline: state.t1 + 60 * MIN - 30_000 });
	await new Promise((r) => setTimeout(r, 5_000)); // let a killed child flush anything it was going to write
	const filesAfter = readdirSync(dirname(sessionFile)).sort();
	writeFileSync(statePath, JSON.stringify({ ...state, refresh: launchedAt, refreshUsage: usage }, null, 2));
	console.log(`W at T1+${((launchedAt - state.t1) / MIN).toFixed(1)}m ${describe(usage)}`);
	console.log(`original session file unchanged: ${sha(sessionFile) === before}`);
	console.log(`new files in project dir: ${JSON.stringify(filesAfter.filter((f) => !filesBefore.includes(f)))}`);
	console.log(`tool handler calls: ${toolCalls}`);
	if (sha(sessionFile) !== before || filesAfter.some((file) => !filesBefore.includes(file)) || toolCalls !== 0) throw new Error("refresh isolation check failed");
	console.log(`run "t2" between ${new Date(state.t1 + 61 * MIN).toLocaleTimeString()} and ${new Date(launchedAt + 58 * MIN).toLocaleTimeString()}`);
} else {
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	if (!state.refresh || !existsSync(getSessionPath(state.sessionId, dir, process.env.CLAUDE_CONFIG_DIR))) throw new Error("run t1 and refresh first");
	const now = Date.now();
	if (now < state.t1 + 61 * MIN || now > state.refresh + 58 * MIN) {
		console.error(`outside the window: T1+${((now - state.t1) / MIN).toFixed(1)}m, W+${((now - state.refresh) / MIN).toFixed(1)}m`);
		process.exit(1);
	}
	const { usage } = await realTurn("Reply with exactly: OK again", state.sessionId);
	writeFileSync(statePath, JSON.stringify({ ...state, t2: now, t2Usage: usage }, null, 2));
	console.log(`T2 at T1+${((now - state.t1) / MIN).toFixed(1)}m, W+${((now - state.refresh) / MIN).toFixed(1)}m ${describe(usage)}`);
	console.log("a read share near 1 means the refresh renewed the entry; near 0 means it did not");
}
