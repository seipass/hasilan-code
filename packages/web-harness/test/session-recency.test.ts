import { describe, expect, it } from "vitest";
import { sessionRecency } from "../src/client/session-recency.ts";

describe("sessionRecency", () => {
	const now = new Date("2026-11-08T12:00:00Z").getTime();
	it("does not invent an activity date for sessions without a recorded run", () => {
		expect(sessionRecency(undefined, now)).toBe("日時未記録");
		expect(sessionRecency("invalid", now)).toBe("日時未記録");
	});
	it("keeps recent activity readable", () => {
		expect(sessionRecency("2026-11-08T11:59:45Z", now)).toBe("たった今");
		expect(sessionRecency("2026-11-08T11:55:00Z", now)).toBe("5 分前");
		expect(sessionRecency("2026-11-08T10:00:00Z", now)).toBe("2 時間前");
	});
	it("uses relative calendar labels for older activity", () => {
		expect(sessionRecency("2026-11-07T12:00:00Z", now)).toBe("昨日");
		expect(sessionRecency("2026-10-01T12:00:00Z", now)).toBe("先月");
		expect(sessionRecency("2025-10-01T12:00:00Z", now)).toBe("昨年");
	});
	it("tolerates a server clock ahead of the client", () => {
		expect(sessionRecency("2026-11-08T13:00:00Z", now)).toBe("たった今");
	});
});
