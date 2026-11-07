/**
 * What Claude Code's cache usage proves, as the cache-stove adapter reports it
 * (src/cache-stove-adapter.ts). Expectations come from the agreed contract:
 * - TTL begins at the request's anchor; 1h known only from evidence, never guessed.
 * - Only a known 1h cache is maintained; anything else is shown warm for 5 minutes.
 * - A refresh that missed the cache is not maintained; one that confirms nothing changes nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCacheUsage, estimateCache } from "../src/cache-stove-adapter.js";

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

	it("exclusive 1h writes establish a 1h prefix regardless of prior read lifetime", () => {
		for (const prior of [null, "unknown", "5m", "1h"]) {
			assert.equal(classifyCacheUsage(readWrite1h, prior).ttl, "1h");
		}
	});

	it("a pure read keeps the known TTL of its chain and is unknown without one", () => {
		assert.equal(classifyCacheUsage(pureRead, "1h").ttl, "1h");
		assert.equal(classifyCacheUsage(pureRead, null).ttl, "unknown");
		assert.equal(classifyCacheUsage(pureRead, "5m").ttl, "5m");
	});

	it("any 5m write makes the shortest lifetime 5m, even on a 1h chain", () => {
		assert.equal(classifyCacheUsage(write5m, "1h").ttl, "5m");
		assert.equal(classifyCacheUsage({ ...readWrite1h,
			cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 682 },
		}, "1h").ttl, "5m");
	});

	it("writes without a TTL breakdown are unknown, not 1h", () => {
		const { cache_creation, ...noBreakdown } = cold1h;
		assert.equal(classifyCacheUsage(noBreakdown, null).ttl, "unknown");
		assert.equal(classifyCacheUsage({ ...readWrite1h, cache_creation: undefined }, "1h").ttl, "unknown");
		assert.equal(classifyCacheUsage({ ...readWrite1h,
			cache_creation: { ephemeral_1h_input_tokens: 682 },
		}, "1h").ttl, "unknown");
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

describe("estimateCache", () => {
	const t0 = 1_000_000;

	it("a known 1h cache expires an hour after its anchor and is maintained", () => {
		const { known, estimate } = estimateCache(cold1h, null, t0);
		assert.deepEqual(estimate, { expiresAt: t0 + HOUR, maintain: true });
		assert.equal(known.ttl, "1h");
	});

	it("an unknown or 5m cache is warm for 5 minutes and not maintained", () => {
		for (const usage of [pureRead, write5m]) {
			const { estimate } = estimateCache(usage, null, t0);
			assert.equal(estimate.expiresAt, t0 + 5 * MIN);
			assert.equal(estimate.maintain, false);
			assert.match(estimate.reason, /5 minutes|not known to be 1 hour/);
		}
	});

	it("a read keeps a 1h chain only while that chain is unexpired", () => {
		const { known } = estimateCache(cold1h, null, t0);
		assert.equal(estimateCache(pureRead, known, t0 + 30 * MIN).estimate.maintain, true);
		assert.equal(estimateCache(pureRead, known, t0 + HOUR).estimate.maintain, false);
	});

	it("after an invalidation, reads with exclusive 1h writes re-establish maintenance", () => {
		const { known, estimate } = estimateCache(readWrite1h, null, t0);
		assert.deepEqual(estimate, { expiresAt: t0 + HOUR, maintain: true });
		assert.equal(known.ttl, "1h");
		assert.deepEqual(estimateCache(readWrite1h, null, t0, true).estimate,
			{ expiresAt: t0 + HOUR, maintain: true });
	});

	it("a request that confirms nothing reports no warmth and forgets the chain", () => {
		const { known } = estimateCache(cold1h, null, t0);
		const miss = { input_tokens: 9_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
		const after = estimateCache(miss, known, t0 + MIN);
		assert.equal(after.estimate.expiresAt, null);
		assert.equal(after.known, null);
	});

	it("a refresh that rewrote the prefix is not maintained; one that confirms nothing keeps the chain", () => {
		const { known } = estimateCache(cold1h, null, t0);
		const rewrote = estimateCache({ ...cold1h, input_tokens: 12 }, known, t0 + 58 * MIN, true);
		assert.equal(rewrote.estimate.expiresAt, t0 + 118 * MIN);
		assert.equal(rewrote.estimate.maintain, false);
		assert.match(rewrote.estimate.reason, /missed the cache/);
		const nothing = estimateCache({ input_tokens: 9_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, known, t0 + 58 * MIN, true);
		assert.equal(nothing.estimate.expiresAt, null);
		assert.equal(nothing.known, known);
		assert.equal(estimateCache(pureRead, known, t0 + 58 * MIN, true).estimate.maintain, true);
	});

	it("a refresh is maintained down to 80% read from cache, and not below", () => {
		const { known } = estimateCache(cold1h, null, t0);
		const refresh = (read) => estimateCache({ input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: 1_000 - read,
			cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 - read } }, known, t0 + 58 * MIN, true).estimate;
		assert.equal(refresh(800).maintain, true, "80% read: a rewritten tail");
		assert.equal(refresh(799).maintain, false);
		assert.match(refresh(799).reason, /missed the cache/);
	});
});
