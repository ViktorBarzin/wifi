/**
 * Device names and fixed addresses. Client-safe: no server imports. A name
 * becomes `<name>.viktorbarzin.lan` (the router turns it into a DHCP host
 * entry, which the DNS import reads), so it is one lowercase DNS label.
 */
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The London LAN; .1 is the router. */
const LAN = /^192\.168\.8\.(25[0-4]|2[0-4]\d|1\d\d|[1-9]\d|[2-9])$/;

export function isDeviceName(value: string): boolean {
	return NAME.test(value);
}

/** A host address on 192.168.8.0/24 other than the router's. */
export function isFixedAddress(value: string): boolean {
	return LAN.test(value);
}
