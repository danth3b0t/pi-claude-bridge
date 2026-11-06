/**
 * The stove's wiring into the provider (src/index.ts) and its refresh transport.
 *
 * Drives real provider turns with a mocked SDK query() (see setQuery), so what is
 * pinned is the bridge's side of the contract: which request each cache report is
 * anchored to, which session events invalidate, and that a refresh replays the
 * real query's recipe with only the isolation overrides added. Whether Claude Code
 * honours that recipe byte-for-byte is a live question this file cannot answer.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRefresh } from "../src/stove.js";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-stove-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { __test } = mod;

let providerConfig;
const commands = new Map();
const handlers = new Map();
const entries = [];
mod.default({
	on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
	registerCommand: (name, options) => commands.set(name, options),
	appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	getActiveTools: () => ["read"],
});
const emit = async (event, ...args) => { for (const h of handlers.get(event) ?? []) await h(...args); };
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const readTool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const writeTool = { name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const usage = (read, write) => ({ input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } });
const ev = (event, parent = null) => ({ type: "stream_event", event, parent_tool_use_id: parent });
const start = (id, u, parent) => ev({ type: "message_start", message: { id, usage: u } }, parent);
const text = (s) => [
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const toolUse = (id) => [
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const result = { type: "result", subtype: "success", is_error: false, result: "ok" };

let ts = 0;
const user = (t) => ({ role: "user", content: t, timestamp: ts++ });
const toolCallMsg = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: "claude-bridge", provider: "claude-bridge", model: "m", stopReason: "toolUse", timestamp: ts++,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: ts++ });
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const settle = () => new Promise((r) => setTimeout(r, 20));

const queries = [];
function fakeQuery(steps) {
	return ({ prompt, options }) => {
		const record = { prompt, options, closed: false, pulledAfterClose: false };
		queries.push(record);
		const gen = (async function* () {
			for (const step of steps) {
				if (typeof step === "function") { await step(); continue; }
				if (record.closed) record.pulledAfterClose = true;
				yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { record.closed = true; };
		return gen;
	};
}

/** A stand-in stove for one pi session: records what the bridge reports to it. */
function fakeStove() {
	const calls = [];
	return {
		calls,
		recordUsage: (u, anchor) => calls.push({ kind: "usage", read: u.cache_read_input_tokens, anchor }),
		invalidate: (reason) => calls.push({ kind: "invalidate", reason }),
		setBusy() {}, setSupported() {}, setEnabled() {}, dispose() {}, describe: () => "",
		get enabled() { return false; },
	};
}

beforeEach(() => {
	__test.resetSharedSession();
	__test.stoveSessions.clear();
	queries.length = 0;
});
afterEach(() => {
	__test.setQuery(null);
	mock.timers.reset();
});

describe("cache evidence from real requests", () => {
	it("anchors each main-thread message_start at the input that started its request, not at receipt", async () => {
		mock.timers.enable({ apis: ["Date"], now: 1_000 });
		const stove = fakeStove();
		__test.stoveSessions.set("s1", { stove });
		const g = gate();
		__test.setQuery(fakeQuery([
			init("cc-1"),
			() => mock.timers.tick(5_000), start("m1", usage(0, 9_000)), // receipt 6_000, request began after 1_000
			start("sub", usage(1, 1), "toolu_parent"), // a subagent's request is not this conversation's
			...toolUse("toolu_1"),
			g.wait,
			() => mock.timers.tick(5_000), start("m2", usage(9_000, 100)), // receipt 25_000, began after delivery at 20_000
			() => mock.timers.tick(1_000), start("m3", usage(9_100, 0)), // restream: began after m2 arrived
			...text("done"), result,
		]));
		const u1 = user("hi"), a1 = toolCallMsg("toolu_1"), r1 = toolResult("toolu_1");
		const first = streamSimple(model, { messages: [u1], tools: [readTool] }, { sessionId: "s1" });
		await first.result();
		mock.timers.tick(14_000); // 20_000: pi hands back the tool result
		const second = streamSimple(model, { messages: [u1, a1, r1], tools: [readTool] }, { sessionId: "s1" });
		g.open();
		await second.result();
		assert.deepEqual(stove.calls.filter((c) => c.kind === "usage"), [
			{ kind: "usage", read: 0, anchor: 1_000 },
			{ kind: "usage", read: 9_000, anchor: 20_000 },
			{ kind: "usage", read: 9_100, anchor: 25_000 },
		]);
	});

	it("reports nothing for a session without a stove", async () => {
		const stove = fakeStove();
		__test.stoveSessions.set("other", { stove });
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [] }, { sessionId: "s1" }).result();
		assert.deepEqual(stove.calls, []);
	});
});

describe("invalidation", () => {
	it("a mirror marked for rebuild or dropped invalidates only its own session", () => {
		const s1 = fakeStove(), s2 = fakeStove();
		__test.stoveSessions.set("s1", { stove: s1 });
		__test.stoveSessions.set("s2", { stove: s2 });
		__test.setSharedSession("s1", { sessionId: "cc-1", cursor: 1, cwd: "/tmp", needsRebuild: true });
		assert.equal(s1.calls.filter((c) => c.kind === "invalidate").length, 1);
		__test.setSharedSession("s1", null);
		assert.equal(s1.calls.filter((c) => c.kind === "invalidate").length, 2);
		__test.setSharedSession("s1", { sessionId: "cc-1", cursor: 1, cwd: "/tmp" });
		assert.equal(s1.calls.filter((c) => c.kind === "invalidate").length, 2);
		__test.markRebuildForSession("s1", "session_compact");
		assert.equal(s1.calls.filter((c) => c.kind === "invalidate").length, 3);
		assert.deepEqual(s2.calls, []);
	});
});

describe("refresh recipe", () => {
	it("replays the real query's options, with fork, no persistence and one turn added", async () => {
		__test.stoveSessions.set("s1", { stove: fakeStove() });
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1", reasoning: "high" }).result();
		const real = queries[0].options;

		__test.setQuery(fakeQuery([init("cc-fork"), start("w1", usage(9_000, 10))]));
		const got = await __test.refreshForSession("s1", new AbortController().signal, Date.now() + 60_000);
		assert.equal(got.cache_read_input_tokens, 9_000);
		const refresh = queries[1].options;
		const ignored = new Set(["resume", "mcpServers", "debug", "debugFile", "stderr", "forkSession", "persistSession", "maxTurns"]);
		for (const key of Object.keys(real)) {
			if (!ignored.has(key)) assert.deepEqual(refresh[key], real[key], `option ${key} differs`);
		}
		assert.equal(refresh.resume, "cc-1");
		assert.equal(refresh.forkSession, true);
		assert.equal(refresh.persistSession, false);
		assert.equal(refresh.maxTurns, 1);
		assert.deepEqual(Object.keys(refresh.mcpServers), Object.keys(real.mcpServers));
	});

	it("follows a mid-query tool set change", async () => {
		__test.stoveSessions.set("s1", { stove: fakeStove() });
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1" }).result();
		const { QueryContext } = await import("../src/query-state.js");
		const c = new QueryContext();
		c.piSessionId = "s1";
		c.toolServer = { setTools: async () => true };
		c.toolNameToPi = new Map();
		c.servedToolNames = ["read"];
		await __test.syncServedTools(c, { messages: [], tools: [readTool, writeTool] });
		assert.deepEqual(__test.stoveSessions.get("s1").recipe.tools.map((t) => t.name), ["read", "write"]);
	});

	it("refuses to refresh a session whose mirror is missing or must be rebuilt", async () => {
		__test.stoveSessions.set("s1", { stove: fakeStove() });
		await assert.rejects(__test.refreshForSession("s1", new AbortController().signal, Date.now() + 60_000));
		assert.equal(queries.length, 0);
	});

	it("spawns nothing when cancelled or past its deadline while the runtimes load", async () => {
		__test.stoveSessions.set("s1", { stove: fakeStove() });
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1" }).result();
		__test.setQuery(fakeQuery([start("w1", usage(9_000, 10))]));
		const controller = new AbortController();
		const cancelled = __test.refreshForSession("s1", controller.signal, Date.now() + 60_000);
		controller.abort(); // lands while the loaders are awaited
		await assert.rejects(cancelled);
		mock.timers.enable({ apis: ["Date"], now: 1_000 });
		const late = __test.refreshForSession("s1", new AbortController().signal, 2_000);
		mock.timers.tick(5_000); // the loaders took past the deadline
		await assert.rejects(late, /deadline/);
		assert.equal(queries.length, 1, "only the real query ever spawned");
	});
});

describe("runRefresh", () => {
	const recipe = { options: { model: "opus", includePartialMessages: true }, tools: [{ name: "read", description: "d", inputSchema: readTool.parameters }] };
	let served;
	const createToolServer = (name, defs) => { served = defs; return { type: "sdk", name }; };

	it("serves the recipe's tools with handlers that refuse every call", async () => {
		const query = fakeQuery([start("w1", usage(9_000, 10))]);
		await runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: new AbortController().signal, deadline: Date.now() + 60_000 });
		assert.deepEqual(served.map((t) => t.name), ["read"]);
		const reply = await served[0].handler("toolu_x", { path: "/etc/passwd" });
		assert.equal(reply.isError, true);
		assert.equal(typeof queries.at(-1).prompt, "string");
	});

	it("returns the first main-thread usage and closes the child without reading on", async () => {
		const query = fakeQuery([start("sub", usage(1, 1), "toolu_p"), start("w1", usage(9_000, 10)), ...text("OK"), result]);
		const got = await runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: new AbortController().signal, deadline: Date.now() + 60_000 });
		assert.equal(got.cache_read_input_tokens, 9_000);
		assert.equal(queries.at(-1).closed, true);
		assert.equal(queries.at(-1).pulledAfterClose, false);
	});

	it("rejects when the child ends before any request reports usage", async () => {
		const query = fakeQuery([{ type: "result", subtype: "success", is_error: true, result: "429" }]);
		await assert.rejects(runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: new AbortController().signal, deadline: Date.now() + 60_000 }), /429/);
		assert.equal(queries.at(-1).closed, true);
	});

	it("an abort closes the child and rejects", async () => {
		const controller = new AbortController();
		const query = fakeQuery([() => new Promise(() => {})]);
		const pending = runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: controller.signal, deadline: Date.now() + 60_000 });
		await settle();
		controller.abort();
		await assert.rejects(pending);
		assert.equal(queries.at(-1).closed, true);
	});

	it("gives up at its absolute deadline", async () => {
		const query = fakeQuery([() => new Promise(() => {})]);
		await assert.rejects(runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: new AbortController().signal, deadline: Date.now() + 20 }), /deadline/);
		assert.equal(queries.at(-1).closed, true);
	});

	it("spawns nothing once its deadline has passed", async () => {
		const before = queries.length;
		const query = fakeQuery([start("w1", usage(9_000, 10))]);
		await assert.rejects(runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: new AbortController().signal, deadline: Date.now() - 1 }), /deadline/);
		assert.equal(queries.length, before);
	});

	it("stops at Claude Code's first API retry instead of waiting for the retried request", async () => {
		const retry = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 30_000, error_status: 529, error: "overloaded", uuid: "u", session_id: "s" };
		const query = fakeQuery([retry, start("w1", usage(0, 9_000))]);
		await assert.rejects(runRefresh({ query, createToolServer, recipe, resume: "cc-1", signal: new AbortController().signal, deadline: Date.now() + 60_000 }), /retry/);
		assert.equal(queries.at(-1).closed, true);
		assert.equal(queries.at(-1).pulledAfterClose, false);
	});
});

describe("/stove command", () => {
	function tuiCtx(sessionId, branch = []) {
		const statuses = new Map();
		return {
			statuses,
			ctx: {
				mode: "tui", hasUI: true, cwd: "/tmp",
				model: { provider: "claude-bridge", id: "claude-opus-5-5" },
				isIdle: () => true,
				ui: { setStatus: (key, text) => (text === undefined ? statuses.delete(key) : statuses.set(key, text)), notify: () => {}, theme: { fg: (_c, s) => s } },
				sessionManager: { getSessionId: () => sessionId, getBranch: () => branch, getEntries: () => branch },
			},
		};
	}
	const shown = (statuses) => [...statuses.values()].sort();

	it("is off by default, toggles, persists intent, and shows paused until warmth is known", async () => {
		const { ctx, statuses } = tuiCtx("t1");
		const notifications = [];
		ctx.ui.notify = (text) => notifications.push(text);
		await emit("session_start", { reason: "startup" }, ctx);
		assert.deepEqual(shown(statuses), ["cache ❄️"]);
		await commands.get("stove").handler("", ctx);
		assert.deepEqual(shown(statuses), ["cache ❄️", "stove ⏸"]);
		assert.deepEqual(entries.at(-1).data, { enabled: true });
		await commands.get("stove").handler("off", ctx);
		assert.deepEqual(shown(statuses), ["cache ❄️"]);
		assert.deepEqual(entries.at(-1).data, { enabled: false });
		await commands.get("stove").handler("on", ctx);
		assert.deepEqual(shown(statuses), ["cache ❄️", "stove ⏸"]);
		assert.deepEqual(notifications, [], "toggles only update the footer");
		await commands.get("stove").handler("status", ctx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /stove: paused/);
		await emit("session_shutdown", { reason: "quit" }, ctx);
	});

	it("restores the intent on resume but never warm confidence", async () => {
		const branch = [{ type: "custom", customType: "claude-bridge-stove", data: { enabled: true } }];
		const { ctx, statuses } = tuiCtx("t2", branch);
		await emit("session_start", { reason: "resume" }, ctx);
		assert.deepEqual(shown(statuses), ["cache ❄️", "stove ⏸"]);
		await emit("session_shutdown", { reason: "quit" }, ctx);
	});

	for (const enable of [true, false]) {
		it(enable ? "/stove on refreshes a known 1h cache at its deadline, with no environment opt-in" : "a stove left off never refreshes", async () => {
			delete process.env.CLAUDE_BRIDGE_STOVE_REFRESH;
			mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
			const sid = enable ? "t-on" : "t-off";
			const { ctx } = tuiCtx(sid);
			await emit("session_start", { reason: "startup" }, ctx);
			if (enable) await commands.get("stove").handler("on", ctx);
			__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
			await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: sid }).result();
			await new Promise((r) => setImmediate(r)); // the query's teardown, before pi settles
			await emit("agent_settled", {}, ctx);
			__test.setQuery(fakeQuery([start("w1", usage(9_000, 10))]));
			mock.timers.tick(58 * 60_000); // estimated 1h expiry minus two minutes
			for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
			assert.equal(queries.length, enable ? 2 : 1);
			if (enable) {
				assert.equal(queries[1].options.forkSession, true);
				assert.equal(queries[1].options.resume, "cc-1");
			}
			await emit("session_shutdown", { reason: "quit" }, ctx);
		});
	}

	it("does not run in non-interactive sessions, even with a persisted intent", async () => {
		const branch = [{ type: "custom", customType: "claude-bridge-stove", data: { enabled: true } }];
		const { ctx, statuses } = tuiCtx("t3", branch);
		ctx.mode = "print";
		ctx.hasUI = false;
		await emit("session_start", { reason: "startup" }, ctx);
		assert.deepEqual(shown(statuses), []);
		assert.equal(__test.stoveSessions.has("t3"), false);
	});
});
