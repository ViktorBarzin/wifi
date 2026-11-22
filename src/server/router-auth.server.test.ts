import { describe, expect, test } from "bun:test";

import { routerAuthorized } from "./router-auth.server";

function withAuth(value: string | null): Request {
	return new Request("http://wifi.invalid/api/router/roles", {
		headers: value === null ? {} : { authorization: value },
	});
}

const TOKEN = "router-token-0123456789abcdef";

describe("router token", () => {
	test("the right bearer token passes", () => {
		expect(routerAuthorized(withAuth(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
	});

	test("a missing, wrong, shorter, longer or non-bearer token fails", () => {
		for (const value of [
			null,
			"",
			"Bearer ",
			"Bearer wrong",
			`Bearer ${TOKEN.slice(0, -1)}`,
			`Bearer ${TOKEN}x`,
			`Basic ${TOKEN}`,
			TOKEN,
		])
			expect(routerAuthorized(withAuth(value), TOKEN)).toBe(false);
	});

	test("no token is configured: nothing passes", () => {
		expect(routerAuthorized(withAuth("Bearer "), null)).toBe(false);
		expect(routerAuthorized(withAuth(`Bearer ${TOKEN}`), null)).toBe(false);
	});
});
