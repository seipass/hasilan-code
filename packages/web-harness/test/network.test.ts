import { describe, expect, it, vi } from "vitest";
import { getLanAddresses } from "../src/server/network.ts";

vi.mock("node:os", () => ({
	networkInterfaces: () => ({
		Tailscale: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
		loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		public: [{ address: "203.0.113.1", family: "IPv4", internal: false }],
	}),
}));

describe("network addresses", () => {
	it("discovers a Tailscale IPv4 address for launch links", () => {
		expect(getLanAddresses()).toEqual(["100.101.102.103"]);
	});
});
