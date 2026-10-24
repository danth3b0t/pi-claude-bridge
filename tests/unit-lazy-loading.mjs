/** Cold-runtime tests in fresh processes: no Claude subprocesses or API calls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";

const scenario = process.argv[2];
if (!scenario) {
	for (const name of ["activation", "orphan-abort", "concurrent", "abort", "sdk-failure", "mcp-failure", "summary", "askclaude"]) {
		test(`lazy runtime: ${name}`, { timeout: 20_000 }, () => {
			const child = spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/lib/setup.mjs", import.meta.filename, name], {
				encoding: "utf8", timeout: 15_000,
			});
			assert.equal(child.status, 0, child.stdout + child.stderr);
		});
	}
} else {
	// Pi already owns these modules when it loads extensions. Preload the host,
	// then police the bridge's import graph, including indirect MCP imports.
	await Promise.all([
		import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-ai/compat"),
		import("@earendil-works/pi-tui"), import("typebox"),
	]);
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const runtime = globalThis.__lazyRuntime = { loads: 0, calls: [], gate, query: undefined };
	const sdkSource = `globalThis.__lazyRuntime.loads++; await globalThis.__lazyRuntime.gate;
		export const query = (args) => globalThis.__lazyRuntime.query(args);`;
	const sdkUrl = `data:text/javascript,${encodeURIComponent(sdkSource)}`;
	const loader = `
		let failed = false;
		export async function resolve(specifier, context, nextResolve) {
			const sdk = specifier === "@anthropic-ai/claude-agent-sdk";
			const mcp = specifier.includes("mcp-server.") || specifier.startsWith("@modelcontextprotocol/");
			const scenario = ${JSON.stringify(scenario)};
			if ((sdk || mcp) && ["activation", "orphan-abort"].includes(scenario)) throw new Error("eager dependency: " + specifier);
			if (mcp && ["summary", "askclaude"].includes(scenario)) throw new Error("unneeded MCP dependency: " + specifier);
			if (!failed && ((sdk && scenario === "sdk-failure") || (mcp && scenario === "mcp-failure"))) {
				failed = true;
				throw new Error("injected runtime import failure");
			}
			if (sdk) return { url: ${JSON.stringify(sdkUrl)}, shortCircuit: true };
			return nextResolve(specifier, context);
		}
	`;
	register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

	const { default: activate, __test } = await import("../src/index.ts");
	let provider;
	let askClaude;
	const handlers = new Map();
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), JSON.stringify({ askClaude: { enabled: true } }));
	activate({
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerProvider(_name, config) { provider = config; },
		registerTool(tool) { askClaude = tool; },
	});
	assert.ok(provider?.models.length, "registration must not wait for the runtime");
	assert.ok(askClaude?.parameters, "AskClaude schema remains available");
	assert.equal(runtime.loads, 0, "activation did not evaluate the SDK");
	if (scenario === "activation") {
		for (const fn of handlers.get("session_start")) fn({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => "startup" } });
		assert.equal(runtime.loads, 0, "session_start did not evaluate the SDK");
		process.exit(0);
	}

	const model = { ...provider.models[0], api: "claude-bridge", provider: "claude-bridge" };
	const user = (text) => ({ role: "user", content: text, timestamp: 0 });
	const tool = { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } };
	const context = (text, tools = []) => ({ messages: [user(text)], tools });
	const call = (text, tools = [], options = {}) => provider.streamSimple(model, context(text, tools), { sessionId: text, ...options });
	const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	const waitFor = async (predicate) => {
		const deadline = Date.now() + 5_000;
		while (!predicate()) { assert.ok(Date.now() < deadline, "runtime did not reach expected state"); await tick(); }
	};
	const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };
	const assertFailure = (events, reason, message) => {
		assert.equal(events.length, 1, "one terminal event, no partial output");
		assert.equal(events[0].type, "error");
		assert.equal(events[0].reason, reason);
		assert.match(events[0].error.errorMessage, message);
		assert.equal(__test.activeQueryContexts.size, 0, "failed loading did not claim a query");
	};

	// Real MCP server/JSON-RPC transport; only the Claude query is simulated.
	async function connect(server) {
		let nextId = 0;
		const replies = new Map();
		const transport = { start: async () => {}, close: async () => {}, send: async (msg) => replies.get(msg.id)?.(msg) };
		await server.instance.connect(transport);
		const request = (method, params) => new Promise((resolve) => {
			const id = ++nextId; replies.set(id, resolve); transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});
		await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
		transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
		return request;
	}

	let finishChild;
	const childGate = new Promise((resolve) => { finishChild = resolve; });
	runtime.query = ({ prompt, options }) => {
		const gen = (async function* () {
			const text = typeof prompt === "string" ? prompt : (await prompt[Symbol.asyncIterator]().next()).value.message.content[0].text;
			runtime.calls.push(text);
			yield { type: "system", subtype: "init", session_id: `cc-${text}` };
			if (scenario === "concurrent" && text === "parent") {
				const request = await connect(options.mcpServers["custom-tools"]);
				assert.deepEqual((await request("tools/list", {})).result.tools.map((t) => t.name), ["read"]);
				yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_cold", name: "mcp__custom-tools__read", input: { path: "cold.txt" } }] } };
				const reply = await request("tools/call", { name: "read", arguments: { path: "cold.txt" }, _meta: { "claudecode/toolUseId": "toolu_cold" } });
				assert.equal(reply.result.content[0].text, "cold result");
			}
			if (scenario === "concurrent" && text === "child") await childGate;
			yield result(`answer ${text}`);
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	};

	if (scenario === "orphan-abort") {
		const controller = new AbortController();
		controller.abort();
		const stream = provider.streamSimple(model, { tools: [tool], messages: [{ role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "cancelled" }], isError: true, timestamp: 0 }] }, { signal: controller.signal });
		const events = await collect(stream);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "done");
		assert.equal(events[0].reason, "stop", "an orphaned aborted result still ends normally without loading runtimes");
		assert.deepEqual(runtime.calls, []);
	} else if (scenario === "abort") {
		const controller = new AbortController();
		const stream = call("cancelled", [tool], { signal: controller.signal });
		await waitFor(() => runtime.loads === 1);
		controller.abort();
		release();
		assertFailure(await collect(stream), "aborted", /Operation aborted/);
		assert.deepEqual(runtime.calls, [], "aborting during import never spawns a query");
		assert.equal((await call("retry").result()).stopReason, "stop");
	} else if (scenario === "sdk-failure" || scenario === "mcp-failure") {
		release();
		const tools = scenario === "mcp-failure" ? [tool] : [];
		assertFailure(await collect(call("failure", tools)), "error", /injected runtime import failure/);
		assert.deepEqual(runtime.calls, []);
		assert.equal((await call("retry", tools).result()).stopReason, "stop", "a failed import does not poison the loader cache");
	} else if (scenario === "concurrent") {
		const parent = call("parent", [tool]);
		const child = call("child");
		await waitFor(() => runtime.loads === 1);
		assert.equal(__test.activeQueryContexts.size, 0, "cold callers do not reserve the same context");
		release();
		const first = await parent.result();
		assert.equal(first.stopReason, "toolUse");
		assert.deepEqual(first.content, [{ type: "toolCall", id: "toolu_cold", name: "read", arguments: { path: "cold.txt" } }]);
		await waitFor(() => runtime.calls.length === 2);
		assert.equal(__test.activeQueryContexts.size, 2, "both cold queries have independent contexts");
		const continued = provider.streamSimple(model, { tools: [tool], messages: [user("parent"), first, { role: "toolResult", toolCallId: "toolu_cold", toolName: "read", content: [{ type: "text", text: "cold result" }], isError: false, timestamp: 1 }] }, { sessionId: "parent" });
		assert.equal((await continued.result()).content[0].text, "answer parent");
		finishChild();
		assert.equal((await child.result()).content[0].text, "answer child");
		await waitFor(() => __test.activeQueryContexts.size === 0);
		assert.equal(__test.getSharedSession("parent").sessionId, "cc-parent");
		assert.equal(__test.getSharedSession("child").sessionId, "cc-child");
		assert.equal(runtime.loads, 1, "concurrent imports evaluate the SDK once");
	} else if (scenario === "summary") {
		const controller = new AbortController();
		const stream = call("summary", [], { cacheRetention: "none", signal: controller.signal });
		await waitFor(() => runtime.loads === 1);
		controller.abort();
		release();
		assertFailure(await collect(stream), "aborted", /Operation aborted/);
		assert.deepEqual(runtime.calls, []);
		assert.equal((await call("summary-retry", [], { cacheRetention: "none" }).result()).content[0].text, "answer summary-retry");
	} else if (scenario === "askclaude") {
		release();
		const answer = await askClaude.execute("ask", { prompt: "ask", mode: "none", isolated: true }, undefined, () => {}, {
			cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "ask", getBranch: () => [] },
			getSystemPrompt: () => "",
		});
		assert.ok(answer.content.some((block) => block.text?.includes("answer ask")), JSON.stringify(answer));
	}
}
