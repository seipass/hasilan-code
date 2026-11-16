import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** Addresses used by Tailscale; this range can also be used by other CGNAT networks. */
export function isTailscaleAddress(address: string): boolean {
	if (!isIPv4(address)) return false;
	const [first, second] = address.split(".").map(Number);
	return first === 100 && second >= 64 && second <= 127;
}

/** LAN sharing excludes public and link-local addresses. */
export function isLanAddress(address: string): boolean {
	return isIPv4(address) && (PRIVATE_IPV4.test(address) || isTailscaleAddress(address));
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
