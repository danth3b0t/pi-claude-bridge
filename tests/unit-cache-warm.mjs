/**
 * pi's prompt-cache warm (src/cache-warm.ts): a session's last request re-sent with
 * maxTokens 1. Pins that it forks the recorded Claude Code conversation with the
 * turn's own options and leaves the session as it was, refuses tools, refuses
 * before spawning whenever the next turn would not resume that conversation, and
 * stops on abort and at Claude Code's first API retry. Whether Claude Code's fork
 * reads the same cached prefix is a live question; see diag/probe-stove-refresh.mjs.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";

const root = process.env.CLAUDE_CONFIG_DIR;
const mod = await import("../src/index.js");
const { setQuery, getSharedSession, resetSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; } });
const [model, otherModel] = providerConfig.models;
const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const user = (content) => ({ role: "user", content, timestamp: 1 });
const usage = { input_tokens: 3, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 400,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 } };
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };

/** Every query the bridge started: its options, and whether it was closed. */
let queries;
/** What the next warm child does after it starts: yields its steps in order. */
let warmSteps;

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	queries = [];
	warmSteps = [{ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "w", usage } } }];
	setQuery(({ prompt, options }) => {
		const record = { prompt, options, closed: false };
		queries.push(record);
		const gen = options.persistSession === false ? warmChild(record) : realTurn(prompt, options);
		gen.interrupt = async () => {};
		gen.close = () => { record.closed = true; };
		return gen;
	});
});
afterEach(() => setQuery(null));

async function* warmChild(record) {
	for (const step of warmSteps) {
		if (typeof step === "function") await step();
		else if (!record.closed) yield step;
	}
}

/** A real turn that writes its transcript the way Claude Code does, so the bridge records it. */
async function* realTurn(prompt, options) {
	const sessionId = options.sessionId ?? options.resume;
	const path = getSessionPath(sessionId, options.cwd, root);
	let parentUuid = null;
	const write = (role, content, uuid) => {
		const builder = createSession({ projectPath: options.cwd, sessionId });
		if (role === "assistant") builder.addAssistantMessage(content);
		else builder.addUserMessage(content);
		const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid };
		parentUuid = value.uuid;
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify(value) + "\n");
		return value;
	};
	const input = prompt[Symbol.asyncIterator]();
	const initial = (await input.next()).value;
	void input.next().catch(() => {});
	write("user", initial.message.content, initial.uuid);
	yield { type: "system", subtype: "init", session_id: sessionId };
	yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, session_id: sessionId, message: initial.message };
	const content = [{ type: "text", text: "answer" }];
	const value = write("assistant", content);
	yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, message: { id: `msg_${sessionId}`, model: model.id, content } };
	yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: sessionId };
}

const turn = (sid, messages) => providerConfig.streamSimple(model, { messages, tools }, { sessionId: sid, reasoning: "high" }).result();
const warm = (sid, messages, extra = {}) =>
	providerConfig.streamSimple(extra.model ?? model, { messages, tools }, { sessionId: sid, reasoning: "high", maxTokens: 1, maxRetries: 0, ...extra }).result();

/** One answered turn in session `sid`: the request pi would warm, and its reply. */
async function answered(sid) {
	const ask = user("hi");
	const reply = await turn(sid, [ask]);
	assert.equal(reply.stopReason, "stop");
	return { ask, reply };
}

// Mirrors the SDK's connectSdkMcpServer, as tests/unit-mcp-server.mjs does.
async function callServedTool(server, name) {
	const pending = new Map();
	const transport = { start: async () => {}, close: async () => {}, send: async (msg) => pending.get(msg.id)?.(msg) };
	await server.instance.connect(transport);
	let id = 0;
	const request = (method, params) => new Promise((resolve) => { pending.set(++id, resolve); transport.onmessage({ jsonrpc: "2.0", id, method, params }); });
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return (await request("tools/call", { name, arguments: { path: "/etc/passwd" }, _meta: { "claudecode/toolUseId": "toolu_x" } })).result;
}

describe("prompt-cache warm", { timeout: 10_000 }, () => {
	it("declares a lifetime on every model, so pi knows a warm keeps its cache", () => {
		for (const m of providerConfig.models) assert.deepEqual(m.promptCache, { short: 300, long: 300 }, m.id);
	});

	it("forks the recorded conversation with the turn's options and leaves the session as it was", async () => {
		const { ask, reply } = await answered("s1");
		const before = structuredClone(getSharedSession("s1"));
		const real = queries[0].options;

		const warmed = await warm("s1", [ask]);
		assert.equal(warmed.stopReason, "stop");
		assert.deepEqual(
			{ input: warmed.usage.input, cacheRead: warmed.usage.cacheRead, cacheWrite: warmed.usage.cacheWrite, cacheWrite1h: warmed.usage.cacheWrite1h },
			{ input: 3, cacheRead: 9_000, cacheWrite: 400, cacheWrite1h: 400 },
		);
		const { options, prompt, closed } = queries[1];
		assert.equal(options.resume, before.ccSessionId);
		assert.equal(options.forkSession, true);
		assert.equal(options.persistSession, false);
		assert.equal(options.maxTurns, 1);
		assert.equal(typeof prompt, "string");
		assert.equal(closed, true, "closed at the first request's usage");
		const turnOnly = new Set(["resume", "sessionId", "forkSession", "resumeSessionAt", "persistSession", "maxTurns", "mcpServers", "env", "stderr", "spawnClaudeCodeProcess"]);
		for (const key of new Set([...Object.keys(real), ...Object.keys(options)])) {
			if (!turnOnly.has(key)) assert.deepEqual(options[key], real[key], `option ${key}`);
		}
		assert.deepEqual(Object.keys(options.mcpServers), Object.keys(real.mcpServers));

		assert.deepEqual(getSharedSession("s1"), before, "the session is untouched");
		// The answered history (with the reply) warms too, and the next turn still resumes.
		assert.equal((await warm("s1", [ask, reply])).stopReason, "stop");
		await turn("s1", [ask, reply, user("again")]);
		assert.equal(queries.at(-1).options.resume, before.ccSessionId);
		assert.equal(queries.at(-1).options.forkSession, undefined);
	});

	it("refuses every tool the warm request serves", async () => {
		const { ask } = await answered("s1");
		await warm("s1", [ask]);
		const reply = await callServedTool(queries[1].options.mcpServers["custom-tools"], "read");
		assert.equal(reply.isError, true);
	});

	it("refuses, spawning nothing, when the next turn would not resume the recorded conversation", async () => {
		const { ask } = await answered("s1");
		const refusals = [
			["no session", () => warm("s2", [ask]), /no Claude Code session/],
			["a changed history", () => warm("s1", [user("something else")]), /history differs/],
			["another model", () => warm("s1", [ask], { model: otherModel }), /another model/],
		];
		for (const [name, send, why] of refusals) {
			const reply = await send();
			assert.equal(reply.stopReason, "error", name);
			assert.match(reply.errorMessage, why, name);
		}
		assert.equal(queries.length, 1, "only the real turn spawned");
	});

	it("refuses while a query of the session is open", async () => {
		const { ask, reply } = await answered("s1");
		const open = gate();
		setQuery(({ options }) => {
			queries.push({ options });
			const gen = (async function* () {
				yield { type: "system", subtype: "init", session_id: options.resume };
				await open.wait;
				yield { type: "result", subtype: "success", is_error: false, result: "x", session_id: options.resume };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		const running = turn("s1", [ask, reply, user("again")]);
		await new Promise((r) => setTimeout(r, 20));
		const refused = await warm("s1", [ask]);
		assert.equal(refused.stopReason, "error");
		assert.match(refused.errorMessage, /query is open/);
		open.open();
		await running;
		assert.equal(queries.length, 2, "the real turns only");
	});

	it("stops, closing the child, on abort and at Claude Code's first API retry", async () => {
		const { ask } = await answered("s1");
		const hang = gate();
		warmSteps = [() => hang.wait];
		const controller = new AbortController();
		const pending = warm("s1", [ask], { signal: controller.signal });
		await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		assert.equal((await pending).stopReason, "aborted");
		assert.equal(queries[1].closed, true);
		hang.open();

		warmSteps = [{ type: "system", subtype: "api_retry", attempt: 1, error_status: 529 }, ...warmSteps];
		const retried = await warm("s1", [ask]);
		assert.equal(retried.stopReason, "error");
		assert.match(retried.errorMessage, /retrying/);
		assert.equal(queries[2].closed, true);
	});
});
