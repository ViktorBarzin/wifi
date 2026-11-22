/**
 * TanStack Query keys, in one place. Biome has no TanStack Query lint, so a
 * typo'd key would silently never invalidate; build every key here.
 */
export const deviceKeys = {
	all: ["devices"] as const,
};
