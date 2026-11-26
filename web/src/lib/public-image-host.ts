// Host/address classification reused from apps/api/src/provider-gateway.ts at 61047a4.
// Only the Node IP format predicate is replaced with the existing browser-safe Zod formats.
// Keep the classification in sync with that authoritative server validation.
import { z } from "zod/v4";
const ipv4Format = z.ipv4(), ipv6Format = z.ipv6();
const isIP = (value: string) => ipv4Format.safeParse(value).success ? 4 : ipv6Format.safeParse(value).success ? 6 : 0;

const blockedProviderHostnames = new Set([
    "localhost", "localhost.localdomain", "ip6-localhost", "metadata", "metadata.google.internal",
    "metadata.google.com", "metadata.azure.com", "instance-data", "instance-data.ec2.internal",
]);

function ipv4Value(address: string): number | null {
    if (isIP(address) !== 4) return null;
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InRange(value: number, start: number, end: number): boolean {
    return value >= start && value <= end;
}

function ipv6Value(address: string): bigint | null {
    if (isIP(address) !== 6) return null;
    const value = address.toLowerCase().split("%", 1)[0];
    const halves = value.split("::");
    if (halves.length > 2) return null;
    const parseWords = (part: string): number[] => {
        if (!part) return [];
        const parts = part.split(":");
        const words: number[] = [];
        for (let index = 0; index < parts.length; index += 1) {
            const partValue = parts[index];
            if (partValue.includes(".")) {
                if (index !== parts.length - 1) return [];
                const ipv4 = ipv4Value(partValue);
                if (ipv4 === null) return [];
                words.push(ipv4 >>> 16, ipv4 & 0xffff);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/.test(partValue)) return [];
            words.push(Number.parseInt(partValue, 16));
        }
        return words;
    };
    const left = parseWords(halves[0]);
    const right = parseWords(halves.length === 2 ? halves[1] : "");
    if (left.length + right.length > 8 || (halves.length === 1 && left.length !== 8)) return null;
    const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
    if (words.length !== 8) return null;
    return words.reduce((result, word) => (result << BigInt(16)) | BigInt(word), BigInt(0));
}

/** Returns true for addresses that must never be contacted as provider targets. */
export function isBlockedProviderAddress(address: string): boolean {
    const ipv4 = ipv4Value(address);
    if (ipv4 !== null) {
        return ipv4InRange(ipv4, 0x00000000, 0x00ffffff) || // unspecified/current network
            ipv4InRange(ipv4, 0x0a000000, 0x0affffff) || // RFC1918
            ipv4InRange(ipv4, 0x64400000, 0x647fffff) || // RFC6598 shared address space
            ipv4InRange(ipv4, 0x7f000000, 0x7fffffff) || // loopback
            ipv4InRange(ipv4, 0xa9fe0000, 0xa9feffff) || // link-local and metadata
            ipv4InRange(ipv4, 0xac100000, 0xac1fffff) || // RFC1918
            ipv4InRange(ipv4, 0xc0000000, 0xc00000ff) || // special-use
            ipv4InRange(ipv4, 0xc0a80000, 0xc0a8ffff) || // RFC1918
            ipv4InRange(ipv4, 0xc6120000, 0xc613ffff) || // benchmarking
            ipv4InRange(ipv4, 0xe0000000, 0xffffffff); // multicast/reserved
    }
    const ipv6 = ipv6Value(address);
    if (ipv6 === null) return true;
    const prefix = (value: bigint, bits: number): bigint => value >> BigInt(128 - bits);
    // Unspecified, loopback, IPv4-mapped addresses, unique-local, link-local,
    // multicast and the IPv6 metadata endpoint are all non-provider targets.
    if (ipv6 === BigInt(0) || ipv6 === BigInt(1) || prefix(ipv6, 7) === BigInt(0b1111110) || prefix(ipv6, 10) === BigInt(0b1111111010) || prefix(ipv6, 8) === BigInt(0xff) || ipv6 === BigInt("0xfd000ec20000000000000000000000fe")) return true;
    const mapped = ipv6 >> BigInt(32);
    if (mapped === BigInt(0xffff)) return isBlockedProviderAddress(`${Number((ipv6 >> BigInt(24)) & BigInt(0xff))}.${Number((ipv6 >> BigInt(16)) & BigInt(0xff))}.${Number((ipv6 >> BigInt(8)) & BigInt(0xff))}.${Number(ipv6 & BigInt(0xff))}`);
    return false;
}

/** Returns true for hostnames that are locally scoped or well-known metadata names. */
export function isBlockedProviderHostname(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!normalized || blockedProviderHostnames.has(normalized)) return true;
    if (normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".localdomain") || normalized.endsWith(".internal")) return true;
    if (isIP(normalized)) return isBlockedProviderAddress(normalized);
    // Single-label names are resolved through local search domains and are not
    // safe as platform-controlled upstream targets.
    return !normalized.includes(".");
}

