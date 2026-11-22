/**
 * The London Wi-Fi roles. Client-safe: no server imports. A device with no
 * role is a guest; the router keeps only the devices that have one.
 */
export const ROLES = [
	"admin",
	"storage",
	"iot",
	"infra-ha",
	"infra-k8s",
	"media",
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
}

/** What a signed-in person's groups say about them. */
export interface Who {
	member: boolean;
	admin: boolean;
}

/** The role a person may give their own device: admins group admin, users group storage. */
export function roleOf(who: Who): Role | null {
	if (who.admin) return "admin";
	if (who.member) return "storage";
	return null;
}

/** On the device they are on, a person may set their own role or guest (null), nothing else. */
export function mayAssignOwn(who: Who, role: Role | null): boolean {
	const own = roleOf(who);
	if (own === null) return false;
	return role === null || role === own;
}
