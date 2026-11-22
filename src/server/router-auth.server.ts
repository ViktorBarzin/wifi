/**
 * The London router's bearer token (env ROUTER_TOKEN). Compared as SHA-256
 * digests with timingSafeEqual, so neither the content nor the length of the
 * expected token leaks through timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

export function routerAuthorized(
	request: Request,
	expected: string | null,
): boolean {
	if (!expected) return false;
	const match = /^Bearer (\S+)$/.exec(
		request.headers.get("authorization") ?? "",
	);
	const given = match?.[1];
	if (!given) return false;
	return timingSafeEqual(digest(given), digest(expected));
}
