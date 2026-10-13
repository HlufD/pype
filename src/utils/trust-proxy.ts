import { BlockList, isIP } from "net";
import type { Request } from "../core/request";

/**
 * Decides whether a proxy address is trusted.
 *
 * @param address - IP address of the hop.
 * @param hop - Distance from the server, 0 is the socket peer.
 */
export type TrustFunction = (address: string, hop: number) => boolean;

/** Subnets behind the named `trust proxy` values. */
const NAMED_RANGES: Record<string, string[]> = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

/**
 * Compiles an Express `trust proxy` setting into a predicate.
 *
 * @param value - `true`/`false`, a hop count, a comma-separated string or
 * array of IPs, CIDRs or the names `loopback`, `linklocal` and
 * `uniquelocal`, or a custom {@link TrustFunction}.
 * @throws When an address in the list is not a valid IP.
 */
export function compileTrust(value: unknown): TrustFunction {
  if (typeof value === "function") return value as TrustFunction;
  if (value === true) return () => true;
  if (typeof value === "number") return (_address, hop) => hop < value;
  if (!value) return () => false;

  const entries = (Array.isArray(value) ? value : String(value).split(","))
    .map((entry: string) => entry.trim())
    .flatMap((entry: string) => NAMED_RANGES[entry] ?? [entry]);

  const list = new BlockList();

  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";

    if (!isIP(address)) throw new TypeError(`Invalid trust proxy address: ${entry}`);

    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }

  return (address) => {
    const normalized = normalizeAddress(address);
    const family = isIP(normalized);
    if (!family) return false;
    return list.check(normalized, family === 6 ? "ipv6" : "ipv4");
  };
}

/** Unwraps IPv4-mapped IPv6 addresses: `::ffff:127.0.0.1` becomes `127.0.0.1`. */
function normalizeAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

/**
 * Addresses from the socket outwards, stopping at the first untrusted hop.
 * Same algorithm as the `proxy-addr` package used by Express.
 *
 * @returns The socket address followed by the `X-Forwarded-For` entries that
 * can be trusted, the last one is the client address.
 */
export function trustedAddresses(req: Request, trust: TrustFunction): string[] {
  const forwarded = ((req.headers["x-forwarded-for"] as string) || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean)
    .reverse();

  const addresses = [req.socket?.remoteAddress || "", ...forwarded];

  for (let i = 0; i < addresses.length - 1; i++) {
    if (!trust(addresses[i], i)) return addresses.slice(0, i + 1);
  }

  return addresses;
}
