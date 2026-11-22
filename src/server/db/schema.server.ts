/**
 * The app's Drizzle schema: the identity tables from @viktorbarzin/auth plus
 * this app's own: devices, device_roles, device_names and sync_state. `bun run db:generate` writes migrations to drizzle/.
 * Migrations are additive (expand, then contract in a later release), so the
 * previous image stays a working rollback.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	pgEnum,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

import { ROLES } from "#/lib/roles";

export * from "@viktorbarzin/auth/schema";

/** Every device the London router has leased an address to. Never deleted: an absent device is offline. */
export const devices = pgTable(
	"devices",
	{
		/** Lowercase, colon form: `aa:bb:cc:00:11:22`. */
		mac: text("mac").primaryKey(),
		ip: text("ip").notNull(),
		hostname: text("hostname"),
		firstSeen: timestamp("first_seen", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		lastSeen: timestamp("last_seen", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("devices_ip_idx").on(table.ip, table.lastSeen)],
);

export const deviceRole = pgEnum("device_role", ROLES);

/** A device's role. No row: the device is a guest. */
export const deviceRoles = pgTable("device_roles", {
	mac: text("mac").primaryKey(),
	role: deviceRole("role").notNull(),
	/** The OIDC `sub` of the person who set it. */
	setBy: text("set_by").notNull(),
	setAt: timestamp("set_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

/**
 * A device's name (`<name>.viktorbarzin.lan`) and, optionally, the address
 * the router always gives it. No row: the device keeps the hostname it sends.
 */
export const deviceNames = pgTable(
	"device_names",
	{
		mac: text("mac").primaryKey(),
		/** One lowercase DNS label (#/lib/names). */
		name: text("name").notNull(),
		/** A 192.168.8.0/24 address, or null for any free one. */
		fixedIp: text("fixed_ip"),
		/** The OIDC `sub` of the person who set it. */
		setBy: text("set_by").notNull(),
		setAt: timestamp("set_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("device_names_name_idx").on(table.name),
		uniqueIndex("device_names_fixed_ip_idx").on(table.fixedIp),
	],
);

/** One row (id 1): the role list's version and what the router last told us. */
export const syncState = pgTable(
	"sync_state",
	{
		id: smallint("id").primaryKey().default(1),
		/** The router list's version: bumped by every role or name write, in the same transaction. */
		rolesVersion: bigint("roles_version", { mode: "number" })
			.default(0)
			.notNull(),
		/** SHA-256 hex of the last lease table the router sent. */
		leasesHash: text("leases_hash").default("").notNull(),
		lastRouterPoll: timestamp("last_router_poll", {
			withTimezone: true,
			mode: "date",
		}),
	},
	(table) => [check("sync_state_one_row", sql`${table.id} = 1`)],
);
