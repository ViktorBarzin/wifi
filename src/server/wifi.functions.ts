/**
 * Server functions for this app's own UI (internal RPC; the router uses the
 * /api/router routes). The device is always found from the request's
 * X-Real-IP, never from the client's input.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { CLIENT_ID_HEADER } from "@viktorbarzin/realtime/client";
import { sanitizeClientId } from "@viktorbarzin/realtime/server";
import { ApiError } from "@viktorbarzin/runtime";
import { z } from "zod";

import { ROLES } from "#/lib/roles";
import { appAuth, requireMember } from "./auth.server";
import { pool } from "./db.server";
import {
	assignOwnDevice,
	clientIp,
	type DeviceView,
	findDeviceByIp,
	listDevices as listAllDevices,
	normalizeMac,
	setRole,
} from "./wifi.server";

const role = z.enum(ROLES).nullable();

/** The device this request comes from, by its address; no sign-in needed. */
export const getThisDevice = createServerFn({ method: "GET" }).handler(
	async (): Promise<{ ip: string | null; device: DeviceView | null }> => {
		const ip = clientIp(getRequest());
		return {
			ip,
			device: ip === null ? null : await findDeviceByIp(pool.getDb(), ip),
		};
	},
);

/** Give the device this request comes from the caller's own role, or make it a guest (null). */
export const setThisDeviceRole = createServerFn({ method: "POST" })
	.validator(z.object({ role }))
	.handler(async ({ data }) => {
		const request = getRequest();
		const user = await requireMember(request);
		await assignOwnDevice(
			pool.getDb(),
			user,
			clientIp(request),
			data.role,
			sanitizeClientId(request.headers.get(CLIENT_ID_HEADER)),
		);
		return { ok: true as const };
	});

async function requireAdmin(request: Request) {
	const user = await requireMember(request);
	await appAuth.requireAdmin(user);
	return user;
}

/** Every device with its role. Admins only. */
export const listDevices = createServerFn({ method: "GET" }).handler(
	async (): Promise<DeviceView[]> => {
		await requireAdmin(getRequest());
		return listAllDevices(pool.getDb());
	},
);

/** Set any device's role; null makes it a guest. Admins only. */
export const setDeviceRole = createServerFn({ method: "POST" })
	.validator(z.object({ mac: z.string().max(17), role }))
	.handler(async ({ data }) => {
		const request = getRequest();
		const user = await requireAdmin(request);
		const mac = normalizeMac(data.mac);
		if (mac === null) throw new ApiError(422, "invalid", "bad mac");
		await setRole(pool.getDb(), {
			mac,
			role: data.role,
			setBy: user.sub ?? user.username,
			source: sanitizeClientId(request.headers.get(CLIENT_ID_HEADER)),
		});
		return { ok: true as const };
	});
