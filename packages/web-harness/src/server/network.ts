import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** LAN sharing excludes public, link-local and VPN carrier-grade NAT addresses. */
export function isLanAddress(address: string): boolean {
	return isIPv4(address) && PRIVATE_IPV4.test(address);
}

export function getLanAddresses(): string[] {
	const addresses = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (!entry.internal && entry.family === "IPv4" && isLanAddress(entry.address)) addresses.add(entry.address);
		}
	}
	return [...addresses];
}
