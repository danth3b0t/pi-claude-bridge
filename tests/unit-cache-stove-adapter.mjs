/**
 * The cache-stove adapter's wiring into the provider (src/index.ts) and its
 * refresh transport, seen from pi.events the way the cache-stove extension sees it.
 *
 * Drives real provider turns with a mocked SDK query() (see setQuery), so what is
 * pinned is the bridge's side of the contract: which request each evidence report
 * is anchored to, which session events invalidate, discovery, and that a refresh
 * replays the real query's recipe with only the isolation overrides added. Whether
 * Claude Code honours that recipe byte-for-byte is a live question this file
 * cannot answer.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { runRefresh } from "../src/cache-stove-adapter.js";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-stove-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { __test } = mod;

let providerConfig;
const handlers = new Map();
const bus = new EventEmitter();
const seen = { evidence: [], invalidate: [], register: [] };
for (const kind of Object.keys(seen)) bus.on(`cache-stove:v1:${kind}`, (data) => seen[kind].push(data));
mod.default({
	on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
	events: { emit: (name, data) => bus.emit(name, data), on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); } },
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

/** The adapter as the stove receives it: on discovery. */
function adapter() {
	seen.register.length = 0;
	bus.emit("cache-stove:v1:discover", { version: 1 });
	assert.equal(seen.register.length, 1);
	return seen.register[0];
}
const lastIdentity = (sid) => seen.evidence.filter((e) => e.sessionId === sid).at(-1).identity;
const refreshReq = (sid, extra = {}) => ({ sessionId: sid, identity: lastIdentity(sid), signal: new AbortController().signal, deadline: Date.now() + 60_000, ...extra });

beforeEach(() => {
	__test.resetSharedSession();
	__test.cacheSessions.clear();
	queries.length = 0;
	for (const list of Object.values(seen)) list.length = 0;
});
afterEach(() => {
	__test.setQuery(null);
	mock.timers.reset();
});

describe("cache evidence from real requests", () => {
	it("anchors each main-thread message_start at the input that started its request, not at receipt", async () => {
		mock.timers.enable({ apis: ["Date"], now: 1_000 });
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
		assert.deepEqual(seen.evidence.map((e) => [e.anchor, e.expiresAt, e.maintain]), [
			[1_000, 1_000 + 3_600_000, true],
			[20_000, 20_000 + 3_600_000, true],
			[25_000, 25_000 + 3_600_000, true],
		]);
	});

	it("tags evidence with its own session, provider and model, and nothing Claude-specific", async () => {
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [] }, { sessionId: "s1" }).result();
		assert.equal(seen.evidence.length, 1);
		const { identity, anchor, expiresAt, ...rest } = seen.evidence[0];
		assert.equal(typeof identity, "string");
		assert.deepEqual(rest, { version: 1, adapter: "claude-bridge", sessionId: "s1", provider: "claude-bridge", model: model.id, maintain: true });
	});
});

describe("invalidation", () => {
	it("a mirror marked for rebuild or dropped invalidates only its own session", () => {
		const count = () => seen.invalidate.filter((i) => i.sessionId === "s1").length;
		__test.setSharedSession("s1", { sessionId: "cc-1", cursor: 1, cwd: "/tmp", needsRebuild: true });
		assert.equal(count(), 1);
		__test.setSharedSession("s1", null);
		assert.equal(count(), 2);
		__test.setSharedSession("s1", { sessionId: "cc-1", cursor: 1, cwd: "/tmp" });
		assert.equal(count(), 2);
		__test.markRebuildForSession("s1", "session_compact");
		assert.equal(count(), 3);
		assert.equal(seen.invalidate.length, 3, "no other session invalidated");
		assert.ok(seen.invalidate.every((i) => i.version === 1 && i.adapter === "claude-bridge"));
	});

	it("a model or thinking change invalidates, and forgets the 1h chain the next read relied on", async () => {
		for (const event of ["model_select", "thinking_level_select"]) {
			__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), start("m2", usage(9_000, 0)), ...text("x"), result]));
			await streamSimple(model, { messages: [user("hi")], tools: [] }, { sessionId: "s1" }).result();
			assert.equal(seen.evidence.at(-1).maintain, true, "a read on a known 1h chain");
			const ctx = { sessionManager: { getSessionId: () => "s1" } };
			for (const h of handlers.get(event)) await h({ model }, ctx);
			assert.equal(seen.invalidate.at(-1).sessionId, "s1");
			const before = seen.evidence.length;
			__test.resetSharedSession(); // a fresh conversation, so the turn reports as the session's own
			__test.setQuery(fakeQuery([init("cc-1"), start("m3", usage(9_000, 0)), ...text("x"), result]));
			await streamSimple(model, { messages: [user("hi")], tools: [] }, { sessionId: "s1" }).result();
			assert.equal(seen.evidence.length, before + 1);
			assert.equal(seen.evidence.at(-1).maintain, false, `${event}: the read prefix's lifetime is unknown again`);
			__test.resetSharedSession();
			__test.cacheSessions.clear();
		}
	});
});

describe("refresh recipe", () => {
	it("replays the real query's options, with fork, no persistence and one turn added", async () => {
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1", reasoning: "high" }).result();
		await settle(); // the query's teardown
		const real = queries[0].options;

		__test.setQuery(fakeQuery([init("cc-fork"), start("w1", usage(9_000, 10))]));
		const before = Date.now();
		const got = await adapter().refresh(refreshReq("s1"));
		assert.equal(got.sessionId, "s1");
		assert.equal(got.identity, lastIdentity("s1"));
		assert.ok(got.anchor >= before, "anchored at launch");
		assert.equal(got.expiresAt, got.anchor + 3_600_000);
		assert.equal(got.maintain, true);
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

	it("follows a mid-query tool set change, which refuses a refresh for the older identity", async () => {
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1" }).result();
		const { QueryContext } = await import("../src/query-state.js");
		const c = new QueryContext();
		c.piSessionId = "s1";
		c.toolServer = { setTools: async () => true };
		c.toolNameToPi = new Map();
		c.servedToolNames = ["read"];
		await __test.syncServedTools(c, { messages: [], tools: [readTool, writeTool] });
		assert.deepEqual(__test.cacheSessions.get("s1").recipe.tools.map((t) => t.name), ["read", "write"]);
		await assert.rejects(adapter().refresh(refreshReq("s1")), /changed/);
		assert.equal(queries.length, 1);
	});

	it("refuses to refresh a session with no conversation, one that must be rebuilt, or one with an open query", async () => {
		await assert.rejects(adapter().refresh({ sessionId: "s1", identity: "0", signal: new AbortController().signal, deadline: Date.now() + 60_000 }));
		const g = gate();
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), g.wait, result]));
		const open = streamSimple(model, { messages: [user("hi")], tools: [] }, { sessionId: "s1" });
		await settle();
		__test.setSharedSession("s1", { sessionId: "cc-1", cursor: 0, cwd: "/tmp" });
		await assert.rejects(adapter().refresh(refreshReq("s1")), /still open/);
		g.open();
		await open.result();
		await settle();
		__test.setSharedSession("s1", { ...__test.getSharedSession("s1"), needsRebuild: true });
		await assert.rejects(adapter().refresh({ ...refreshReq("s1"), identity: String(__test.cacheSessions.get("s1").epoch) }), /no current/);
		assert.equal(queries.length, 1);
	});

	it("spawns nothing when cancelled or past its deadline while the runtimes load", async () => {
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1" }).result();
		await settle();
		__test.setQuery(fakeQuery([start("w1", usage(9_000, 10))]));
		const controller = new AbortController();
		const cancelled = adapter().refresh(refreshReq("s1", { signal: controller.signal }));
		controller.abort(); // lands while the loaders are awaited
		await assert.rejects(cancelled);
		mock.timers.enable({ apis: ["Date"], now: 1_000 });
		const late = adapter().refresh(refreshReq("s1", { deadline: 2_000 }));
		mock.timers.tick(5_000); // the loaders took past the deadline
		await assert.rejects(late, /deadline/);
		assert.equal(queries.length, 1, "only the real query ever spawned");
	});

	it("a refresh invalidated while in flight teaches the bridge nothing when it resolves", async () => {
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1" }).result();
		await settle();
		const g = gate();
		__test.setQuery(fakeQuery([g.wait, start("w1", usage(9_000, 10))]));
		const pending = adapter().refresh(refreshReq("s1"));
		await settle();
		assert.equal(queries.length, 2, "the refresh is in flight");
		__test.markRebuildForSession("s1", "session_compact");
		g.open();
		await assert.rejects(pending, /changed/);
		assert.equal(__test.cacheSessions.get("s1").known, null, "no chain restored for a later read to inherit");
	});

	it("spawns nothing when a real query starts while the runtimes load", async () => {
		const g = gate();
		__test.setQuery(fakeQuery([init("cc-1"), start("m1", usage(0, 9_000)), ...text("x"), result]));
		await streamSimple(model, { messages: [user("hi")], tools: [readTool] }, { sessionId: "s1" }).result();
		await settle();
		const pending = adapter().refresh(refreshReq("s1"));
		__test.setQuery(fakeQuery([init("cc-1"), g.wait, result]));
		const real = streamSimple(model, { messages: [user("hi"), user("again")], tools: [readTool] }, { sessionId: "s1" });
		await assert.rejects(pending, /still open|changed/);
		assert.equal(queries.length, 2, "the real queries only");
		g.open();
		await real.result();
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

describe("discovery", () => {
	it("registers on a version 1 discover and at session_start, never on another version", async () => {
		bus.emit("cache-stove:v1:discover", { version: 2 });
		bus.emit("cache-stove:v1:discover", null);
		assert.equal(seen.register.length, 0);
		const ctx = { cwd: "/tmp", mode: "tui", ui: { notify() {} }, sessionManager: { getSessionId: () => "s9" } };
		for (const h of handlers.get("session_start")) await h({ reason: "startup" }, ctx);
		assert.equal(seen.register.length, 1);
		const announced = seen.register[0];
		assert.deepEqual({ ...announced, refresh: typeof announced.refresh }, { version: 1, id: "claude-bridge", provider: "claude-bridge", refresh: "function" });
		assert.equal(adapter(), announced, "the same adapter answers discovery");
	});

	it("registers no command, footer or preference of its own", () => {
		assert.equal(handlers.has("agent_settled"), false);
		assert.equal(handlers.has("cache_warming_decision"), false);
	});
});
