/**
 * Cache indicator and stove controller (src/stove.ts), against a fake clock.
 *
 * Expectations are written from the agreed contract, not from the implementation:
 * - TTL begins at the request's anchor; 1h known only from evidence, never guessed.
 * - One expiry-driven timer; refresh at expiry minus two minutes, for a known 1h cache only.
 * - Late timers and failures pause without dispatching or retrying; errors never extend.
 * - A real turn cancels the refresh and its completion is ignored.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stove, classifyCacheUsage } from "../src/stove.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

// Usage shapes as Claude Code reports them on message_start (tests/fixtures/sdk-streams).
const cold1h = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 10_088,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_088 } };
const readWrite1h = { input_tokens: 10, cache_read_input_tokens: 9_410, cache_creation_input_tokens: 683,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 683 } };
const pureRead = { input_tokens: 10, cache_read_input_tokens: 10_093, cache_creation_input_tokens: 0 };
const write5m = { input_tokens: 10, cache_read_input_tokens: 9_410, cache_creation_input_tokens: 683,
	cache_creation: { ephemeral_5m_input_tokens: 683, ephemeral_1h_input_tokens: 0 } };

describe("classifyCacheUsage", () => {
	it("a cold request that writes only 1h entries establishes a known 1h cache", () => {
		assert.deepEqual(pick(classifyCacheUsage(cold1h, null)), { confirmed: true, ttl: "1h" });
	});

	it("new 1h writes do not prove the TTL of the prefix they read", () => {
		assert.equal(classifyCacheUsage(readWrite1h, null).ttl, "unknown");
		assert.equal(classifyCacheUsage(readWrite1h, "1h").ttl, "1h");
	});

	it("a pure read keeps the known TTL of its chain and is unknown without one", () => {
		assert.equal(classifyCacheUsage(pureRead, "1h").ttl, "1h");
		assert.equal(classifyCacheUsage(pureRead, null).ttl, "unknown");
	});

	it("any 5m write makes the shortest lifetime 5m, even on a 1h chain", () => {
		assert.equal(classifyCacheUsage(write5m, "1h").ttl, "5m");
	});

	it("writes without a TTL breakdown are unknown, not 1h", () => {
		const { cache_creation, ...noBreakdown } = cold1h;
		assert.equal(classifyCacheUsage(noBreakdown, null).ttl, "unknown");
	});

	it("an uncached tail is allowed but a mostly uncached prompt confirms nothing", () => {
		assert.equal(classifyCacheUsage({ ...pureRead, input_tokens: 500 }, "1h").confirmed, true);
		assert.equal(classifyCacheUsage({ input_tokens: 9_000, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 0 }, "1h").confirmed, false);
		assert.equal(classifyCacheUsage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, null).confirmed, false);
	});
});

function pick({ confirmed, ttl }) {
	return { confirmed, ttl };
}

/** A stove on a fake clock. `fire()` runs the armed timer at its due time unless a time is given. */
function harness({ blocker } = {}) {
	let now = 1_000_000;
	let timer = null;
	const views = [];
	const refreshes = [];
	const deps = {
		now: () => now,
		setTimer: (fn, ms) => (timer = { fn, at: now + ms }),
		clearTimer: (handle) => { if (timer === handle) timer = null; },
		render: (view) => views.push(view),
		blocker: () => blocker?.(),
		refresh: (signal, deadline) => {
			let resolve, reject;
			const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
			refreshes.push({ signal, deadline, resolve, reject, launchedAt: now });
			return promise;
		},
	};
	const stove = new Stove(deps);
	return {
		stove,
		refreshes,
		get view() { return views.at(-1); },
		get timerAt() { return timer?.at; },
		set now(t) { now = t; },
		get now() { return now; },
		/** Advance the clock to `at` (default: the timer's due time) and run the timer. */
		fire(at) {
			const t = timer;
			assert.ok(t, "a timer is armed");
			now = at ?? t.at;
			timer = null;
			t.fn();
		},
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Stove", () => {
	it("starts off: stove hidden, cache not known warm", () => {
		const h = harness();
		h.stove.setSupported(true);
		assert.deepEqual(h.view, { cache: "cold", stove: "off" });
	});

	it("shows the cache indicator with the stove off, and it cools at the estimated expiry", () => {
		const h = harness();
		h.stove.setSupported(true);
		const anchor = h.now;
		h.stove.recordUsage(cold1h, anchor);
		assert.deepEqual(h.view, { cache: "hot", stove: "off" });
		assert.equal(h.timerAt, anchor + HOUR);
		h.fire();
		assert.deepEqual(h.view, { cache: "cold", stove: "off" });
		assert.equal(h.refreshes.length, 0);
	});

	it("real cache activity moves the single refresh deadline forward without refreshing", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		assert.deepEqual(h.view, { cache: "hot", stove: "on" });
		assert.equal(h.timerAt, h.now + HOUR - 2 * MIN);
		h.now += 30 * MIN;
		const second = h.now;
		h.stove.recordUsage(readWrite1h, second);
		assert.equal(h.timerAt, second + HOUR - 2 * MIN);
		assert.equal(h.refreshes.length, 0);
	});

	it("keeps an enabled stove paused for an unknown or 5m cache, which reads hot for 5 minutes only", () => {
		for (const [usage, prior] of [[pureRead, null], [write5m, null]]) {
			const h = harness();
			h.stove.setSupported(true);
			h.stove.setEnabled(true);
			if (prior) h.stove.recordUsage(prior, h.now);
			const anchor = h.now;
			h.stove.recordUsage(usage, anchor);
			assert.deepEqual(h.view, { cache: "hot", stove: "paused" });
			assert.equal(h.timerAt, anchor + 5 * MIN);
			h.fire();
			assert.deepEqual(h.view, { cache: "cold", stove: "paused" });
			assert.equal(h.refreshes.length, 0);
		}
	});

	it("refreshes at expiry minus two minutes and anchors the new expiry at launch", async () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		h.fire();
		assert.equal(h.refreshes.length, 1);
		const launchedAt = h.refreshes[0].launchedAt;
		h.now += 20_000; // the response arrives later; expiry must not drift with it
		h.refreshes[0].resolve(pureRead);
		await settle();
		assert.deepEqual(h.view, { cache: "hot", stove: "on" });
		assert.equal(h.timerAt, launchedAt + HOUR - 2 * MIN);
	});

	it("a late timer pauses without dispatching or catching up", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		const anchor = h.now;
		h.stove.recordUsage(cold1h, anchor);
		h.fire(anchor + HOUR - MIN); // machine slept through the deadline
		assert.equal(h.refreshes.length, 0);
		assert.deepEqual(h.view, { cache: "hot", stove: "paused" });
		h.fire(); // only the expiry is left; it cools and still dispatches nothing
		assert.equal(h.refreshes.length, 0);
		assert.deepEqual(h.view, { cache: "cold", stove: "paused" });
	});

	it("a deadline already past when the evidence arrives never dispatches", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now - HOUR + MIN); // anchor 59 minutes ago
		if (h.timerAt !== undefined && h.timerAt <= h.now) h.fire(h.now);
		assert.equal(h.refreshes.length, 0);
		assert.equal(h.view.stove, "paused");
	});

	it("a timer that fires before the wall-clock deadline re-arms instead of dispatching", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		const anchor = h.now;
		h.stove.recordUsage(cold1h, anchor);
		h.fire(anchor + 30 * MIN); // wall clock moved back relative to the timer
		assert.equal(h.refreshes.length, 0);
		assert.equal(h.timerAt, anchor + HOUR - 2 * MIN);
		assert.deepEqual(h.view, { cache: "hot", stove: "on" });
	});

	it("hands the refresh an absolute deadline before expiry, also when dispatched a little late", () => {
		for (const delay of [0, 20_000]) {
			const h = harness();
			h.stove.setSupported(true);
			h.stove.setEnabled(true);
			const anchor = h.now;
			h.stove.recordUsage(cold1h, anchor);
			h.fire(anchor + HOUR - 2 * MIN + delay);
			assert.equal(h.refreshes.length, 1);
			assert.equal(h.refreshes[0].deadline, anchor + HOUR - 30_000);
		}
	});

	it("aborts a refresh still running at its deadline, pauses, and keeps the old expiry", async () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		const anchor = h.now;
		h.stove.recordUsage(cold1h, anchor);
		h.fire();
		const refresh = h.refreshes[0];
		assert.equal(h.timerAt, refresh.deadline);
		h.fire();
		assert.equal(refresh.signal.aborted, true);
		assert.deepEqual(h.view, { cache: "hot", stove: "paused" });
		assert.equal(h.timerAt, anchor + HOUR);
		refresh.resolve(pureRead); // a completion after the deadline is ignored
		await settle();
		assert.equal(h.timerAt, anchor + HOUR);
		assert.equal(h.view.stove, "paused");
		h.fire();
		assert.equal(h.refreshes.length, 1, "no retry");
		assert.deepEqual(h.view, { cache: "cold", stove: "paused" });
	});

	it("a failed refresh pauses, never extends the old deadline, and is not retried", async () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		const anchor = h.now;
		h.stove.recordUsage(cold1h, anchor);
		h.fire();
		h.refreshes[0].reject(new Error("boom"));
		await settle();
		assert.deepEqual(h.view, { cache: "hot", stove: "paused" });
		assert.equal(h.timerAt, anchor + HOUR);
		h.fire();
		assert.equal(h.refreshes.length, 1);
		assert.deepEqual(h.view, { cache: "cold", stove: "paused" });
	});

	it("a refresh that missed the cache pauses even though it rewrote it", async () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		h.fire();
		h.refreshes[0].resolve({ ...cold1h, input_tokens: 12 });
		await settle();
		assert.deepEqual(h.view, { cache: "hot", stove: "paused" });
		h.fire(); // expiry of the rewritten cache; no second refresh
		assert.equal(h.refreshes.length, 1);
	});

	it("a real turn cancels the in-flight refresh and its late completion is ignored", async () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		const firstAnchor = h.now;
		h.stove.recordUsage(cold1h, firstAnchor);
		h.fire();
		const refresh = h.refreshes[0];
		h.stove.setBusy(true);
		assert.equal(refresh.signal.aborted, true);
		assert.equal(h.timerAt, firstAnchor + HOUR, "only the indicator's expiry stays armed");
		const realAnchor = h.now + 1_000;
		h.stove.recordUsage(readWrite1h, realAnchor);
		refresh.resolve(pureRead);
		await settle();
		h.stove.setBusy(false);
		assert.equal(h.timerAt, realAnchor + HOUR - 2 * MIN);
		assert.deepEqual(h.view, { cache: "hot", stove: "on" });
	});

	it("does not arm the refresh while busy; settling arms it", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.setBusy(true);
		const anchor = h.now;
		h.stove.recordUsage(cold1h, anchor);
		assert.equal(h.timerAt, anchor + HOUR, "only the indicator's expiry is armed");
		h.stove.setBusy(false);
		assert.equal(h.timerAt, anchor + HOUR - 2 * MIN);
	});

	it("invalidation cools the cache and pauses until a real request confirms a new 1h cache", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		h.stove.invalidate("model changed");
		assert.deepEqual(h.view, { cache: "cold", stove: "paused" });
		assert.equal(h.timerAt, undefined);
		h.stove.recordUsage(readWrite1h, h.now); // the read prefix lost its known TTL
		assert.equal(h.view.stove, "paused");
		h.stove.recordUsage(cold1h, h.now);
		assert.deepEqual(h.view, { cache: "hot", stove: "on" });
	});

	it("a real cache-confirmed request rearms a paused stove; off stays off", async () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		h.fire();
		h.refreshes[0].reject(new Error("boom"));
		await settle();
		assert.equal(h.view.stove, "paused");
		h.stove.recordUsage(pureRead, h.now);
		assert.equal(h.view.stove, "on");
		h.stove.setEnabled(false);
		assert.deepEqual(h.view, { cache: "hot", stove: "off" });
		h.stove.recordUsage(pureRead, h.now);
		assert.equal(h.view.stove, "off");
		assert.equal(h.timerAt, h.now + HOUR); // only the indicator's expiry
	});

	it("does not refresh when the bridge reports a blocker at the deadline", () => {
		const h = harness({ blocker: () => "a query is parked at a tool call" });
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		h.fire();
		assert.equal(h.refreshes.length, 0);
		assert.equal(h.view.stove, "paused");
		assert.match(h.stove.describe(), /parked at a tool call/);
	});

	it("hides both indicators on an unsupported model and keeps the intent", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.setSupported(false);
		assert.equal(h.view, null);
		assert.equal(h.stove.enabled, true);
		h.stove.setSupported(true);
		assert.deepEqual(h.view, { cache: "cold", stove: "paused" });
	});

	it("dispose clears the timer and aborts an in-flight refresh", () => {
		const h = harness();
		h.stove.setSupported(true);
		h.stove.setEnabled(true);
		h.stove.recordUsage(cold1h, h.now);
		h.fire();
		h.stove.dispose();
		assert.equal(h.refreshes[0].signal.aborted, true);
		assert.equal(h.timerAt, undefined);
	});
});
