/**
 * A tool call Claude Code is waiting on that pi was never handed.
 *
 * When a response stream dies mid-message (a laptop suspended mid-turn, a
 * network change), Claude Code drops what had streamed and asks again — with a
 * "Your response above was cut off mid-stream" resume, or a non-streaming retry.
 * The bridge had already started on the dead response, and in three incidents it
 * missed the replacement's call:
 *
 * - pi got the dead call as `write {}` / `subagent {}`, ran it, and sent a result
 *   for an id Claude Code had dropped; the resumed call, under a new id, never
 *   reached pi (pi sessions on 2026-09-29, 2026-10-07 and 2026-10-08).
 * - a retried response with two parallel calls reached pi with only the first
 *   (2026-09-29, `bash` + `read`, only `bash` ran).
 *
 * Each time Claude Code sat in the MCP handler for the missing call and pi
 * waited for a response, until the user aborted. The handler is the one record
 * that can't be wrong about what Claude Code waits on, and its tools/call
 * carries the arguments, so the bridge now delivers such a call from there.
 *
 * Drives the real MCP handler through the JSON-RPC layer, as unit-queue does.
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const GRACE = __test.STRANDED_CALL_GRACE_MS;

async function connectClient(server) {
	const pending = new Map();
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async (msg) => pending.get(msg.id)?.(msg),
	};
	await server.instance.connect(transport);
	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return (name, toolUseId, args = {}) =>
		request("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } });
}

// notify_parent and read rather than bash: bash gets a default timeout from
// mapToolArgs, which has nothing to do with what is under test.
const TOOLS = ["notify_parent", "read"].map((name) => ({
	name,
	description: name,
	parameters: { type: "object", properties: {} },
}));

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

async function startQuery() {
	const c = new QueryContext();
	const callTool = await connectClient(Object.values(__test.buildMcpServers(TOOLS, c))[0]);
	return { c, callTool };
}

/** pi's turn ended on toolUse with these calls: what endPiTurnOnToolUse records. */
function piRanCalls(c, ...ids) {
	for (const id of ids) c.deliveredToolCallIds.add(id);
	c.currentPiStream = null;
}

/** pi re-enters with its tool results, as the provider's tool-result path does:
 *  a fresh pi turn, the results delivered, then stranded calls flushed. */
async function piDelivers(c, ...results) {
	const stream = fakeStream();
	c.currentPiStream = stream;
	c.resetTurnState(fakeModel);
	await __test.deliverToolResults(c, results, null, 4);
	__test.flushStrandedToolCalls(c);
	return stream;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const result = (toolCallId, text, isError = false) => ({ toolCallId, content: [{ type: "text", text }], isError });
const replyText = (response) => response.result.content[0].text;
const toolCalls = (stream) => stream.events.filter((e) => e.type === "toolcall_end").map((e) => [e.toolCall.id, e.toolCall.arguments]);
const endedOnToolUse = (stream) => stream.events.some((e) => e.type === "done" && e.reason === "toolUse") && stream.events.at(-1)?.type === "end";

describe("a tool call Claude Code dispatched that pi was never handed", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
	afterEach(() => mock.timers.reset());

	// The cut-off resume, in the order the 2026-10-08 incident ran: pi already ran
	// the dead `write {}` and reopened its turn before Claude Code's resumed call
	// landed in the handler.
	it("reaches pi on its open turn once the grace runs out", async () => {
		const { c, callTool } = await startQuery();
		piRanCalls(c, "toolu_dead");
		const turn = await piDelivers(c, result("toolu_dead", "Validation failed: path, content required", true));
		assert.deepEqual(toolCalls(turn), []);

		const resumed = callTool("notify_parent", "toolu_resumed", { summary: "Both fixes done." });
		await flush();
		assert.ok(c.pendingToolCalls.has("toolu_resumed"));
		assert.ok(!endedOnToolUse(turn), "nothing is delivered inside the grace");

		mock.timers.tick(GRACE);
		assert.deepEqual(toolCalls(turn), [["toolu_resumed", { summary: "Both fixes done." }]]);
		assert.ok(endedOnToolUse(turn));
		assert.ok(c.deliveredToolCallIds.has("toolu_resumed"));

		// And the round trip completes: pi's result answers Claude Code.
		await piDelivers(c, result("toolu_resumed", "sent"));
		assert.equal(replyText(await resumed), "sent");
		assert.equal(c.pendingToolCalls.size, 0);
	});

	// The other order: the resumed call parks while pi is still running the dead
	// one, so there is no pi turn to put it on until pi comes back with results.
	it("waits for pi's next turn when none is open", async () => {
		const { c, callTool } = await startQuery();
		piRanCalls(c, "toolu_dead");

		const resumed = callTool("notify_parent", "toolu_resumed", { summary: "Both fixes done." });
		await flush();
		mock.timers.tick(GRACE);
		assert.ok(c.strandedToolCalls.has("toolu_resumed"));

		const turn = await piDelivers(c, result("toolu_dead", "Validation failed", true));
		assert.deepEqual(toolCalls(turn), [["toolu_resumed", { summary: "Both fixes done." }]]);
		assert.ok(endedOnToolUse(turn));
		assert.equal(c.strandedToolCalls.size, 0);

		await piDelivers(c, result("toolu_resumed", "sent"));
		assert.equal(replyText(await resumed), "sent");
	});

	// 2026-09-29: a retried response carried `bash` and `read`; pi got only the first.
	it("delivers the missing half of a parallel batch, and only that half", async () => {
		const { c, callTool } = await startQuery();
		piRanCalls(c, "toolu_first");

		const first = callTool("notify_parent", "toolu_first", { summary: "first" });
		const second = callTool("read", "toolu_second", { path: "lab03.md" });
		await flush();
		mock.timers.tick(GRACE);

		const turn = await piDelivers(c, result("toolu_first", "r1"));
		assert.equal(replyText(await first), "r1");
		assert.deepEqual(toolCalls(turn), [["toolu_second", { path: "lab03.md" }]]);
		assert.ok(endedOnToolUse(turn));

		await piDelivers(c, result("toolu_second", "r2"));
		assert.equal(replyText(await second), "r2");
		assert.equal(c.pendingToolCalls.size, 0);
	});

	// Negative controls. Without them, delivering every parked call from the
	// handler passes everything above — and runs each normal tool call twice.
	it("leaves alone a call the stream already handed to pi", async () => {
		const { c, callTool } = await startQuery();
		piRanCalls(c, "toolu_normal");
		const call = callTool("notify_parent", "toolu_normal", { summary: "x" });
		await flush();
		mock.timers.tick(GRACE * 10);
		assert.equal(c.strandedToolCalls.size, 0);

		const turn = await piDelivers(c, result("toolu_normal", "done"));
		assert.equal(replyText(await call), "done");
		assert.deepEqual(toolCalls(turn), []);
		assert.ok(!endedOnToolUse(turn), "pi's turn stays open for Claude Code's next response");
	});

	it("leaves alone a call the stream hands to pi within the grace", async () => {
		const { c, callTool } = await startQuery();
		const turn = fakeStream();
		c.currentPiStream = turn;
		c.resetTurnState(fakeModel);
		// The handler parks first — the order the grace exists for.
		const call = callTool("notify_parent", "toolu_late", { summary: "x" });
		await flush();
		c.turnBlocks.push({ type: "toolCall", id: "toolu_late", name: "notify_parent", arguments: { summary: "x" } });
		c.turnSawToolCall = true;
		await __test.consumeQuery((async function* () {
			yield { type: "stream_event", event: { type: "message_start", message: { id: "msg" } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
		})(), new Map(), fakeModel, () => false, c);
		assert.ok(c.deliveredToolCallIds.has("toolu_late"));

		mock.timers.tick(GRACE);
		assert.equal(turn.events.filter((e) => e.type === "done").length, 1, "delivered once, by the stream");
		assert.equal(c.strandedToolCalls.size, 0);
		await piDelivers(c, result("toolu_late", "done"));
		assert.equal(replyText(await call), "done");
	});

	it("does nothing for a call an abort already released", async () => {
		const { c, callTool } = await startQuery();
		const call = callTool("notify_parent", "toolu_x", {});
		await flush();
		c.releasePendingToolCalls("Operation aborted");
		assert.equal(replyText(await call), "Operation aborted");
		mock.timers.tick(GRACE);
		assert.equal(c.strandedToolCalls.size, 0);
	});

	// A non-streaming retry can repeat a call the dead stream had finished and pi
	// had already run, under the same id. Running it twice would repeat a write.
	it("does not hand pi a retried call it already ran", async () => {
		const c = new QueryContext();
		c.currentPiStream = fakeStream();
		c.resetTurnState(fakeModel);
		c.deliveredToolCallIds.add("toolu_ran");
		await __test.consumeQuery((async function* () {
			yield { type: "stream_event", event: { type: "message_start", message: { id: "msg_dead" } } };
			yield { type: "assistant", message: { id: "msg_retry", content: [
				{ type: "tool_use", name: "mcp__custom-tools__notify_parent", id: "toolu_ran", input: { summary: "a" } },
				{ type: "tool_use", name: "mcp__custom-tools__read", id: "toolu_new", input: { path: "b" } },
			] } };
		})(), new Map([["mcp__custom-tools__notify_parent", "notify_parent"], ["mcp__custom-tools__read", "read"]]), fakeModel, () => false, c);
		assert.deepEqual(c.turnOutput.content.filter((b) => b.type === "toolCall").map((b) => b.id), ["toolu_new"]);
		assert.equal(c.turnOutput.stopReason, "toolUse");
	});
});
