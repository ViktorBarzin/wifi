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

/**
 * What each role reaches in Sofia, in plain words, for the role map. The
 * router's rules are the truth (infra scripts/london-flint/london-roles.sh,
 * firewall()); change both together.
 */
export const ROLE_ACCESS: Record<Role | "guest", readonly string[]> = {
	admin: ["all of Sofia"],
	"infra-k8s": ["the Kubernetes network"],
	"infra-ha": [
		"NAS backups",
		"journal upload",
		"vacuum camera",
		"history database",
	],
	media: ["the cluster's web services"],
	storage: ["the file share"],
	iot: [],
	guest: [],
};

/** What every device on the London Wi-Fi reaches, whatever its role. */
export const EVERYONE_REACHES = [
	"the internet",
	"devices in the flat",
	"this page",
] as const;

/** The roles from most access to least, guest last. */
export const ROLES_BY_ACCESS: readonly (Role | "guest")[] = [
	"admin",
	"infra-k8s",
	"infra-ha",
	"media",
	"storage",
	"iot",
	"guest",
];
