import { describe, expect, test } from "bun:test";

import { isDeviceName, isFixedAddress } from "./names";

describe("device names", () => {
	test("a name is one lowercase DNS label", () => {
		expect(isDeviceName("plug-thor")).toBe(true);
		expect(isDeviceName("mbp-london")).toBe(true);
		expect(isDeviceName("a")).toBe(true);
		expect(isDeviceName("x".repeat(63))).toBe(true);
		expect(isDeviceName("x".repeat(64))).toBe(false);
		expect(isDeviceName("Plug-Thor")).toBe(false);
		expect(isDeviceName("-plug")).toBe(false);
		expect(isDeviceName("plug-")).toBe(false);
		expect(isDeviceName("plug.thor")).toBe(false);
		expect(isDeviceName("plug thor")).toBe(false);
		expect(isDeviceName("-")).toBe(false);
		expect(isDeviceName("")).toBe(false);
	});

	test("a fixed address is a host on the London LAN, not the router", () => {
		expect(isFixedAddress("192.168.8.20")).toBe(true);
		expect(isFixedAddress("192.168.8.2")).toBe(true);
		expect(isFixedAddress("192.168.8.254")).toBe(true);
		expect(isFixedAddress("192.168.8.1")).toBe(false);
		expect(isFixedAddress("192.168.8.0")).toBe(false);
		expect(isFixedAddress("192.168.8.255")).toBe(false);
		expect(isFixedAddress("192.168.8.256")).toBe(false);
		expect(isFixedAddress("192.168.8.020")).toBe(false);
		expect(isFixedAddress("192.168.9.20")).toBe(false);
		expect(isFixedAddress("10.0.20.215")).toBe(false);
		expect(isFixedAddress("192.168.8.20 ")).toBe(false);
	});
});
