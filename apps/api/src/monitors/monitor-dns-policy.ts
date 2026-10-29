import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

import { MonitorUrlPolicyError } from "./monitor-url-policy.js";

export type ResolvedAddress = Readonly<{
  address: string;
  family: number;
}>;

export type DnsLookup = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

const systemDnsLookup: DnsLookup = async (hostname) => {
  return lookup(hostname, {
    all: true,
    order: "verbatim",
  });
};

export function isPublicRoutableAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) {
    return false;
  }

  try {
    // Normalize IPv4-mapped IPv6 addresses before classification.
    const parsed = ipaddr.process(address);

    // Permit only addresses classified as ordinary unicast.
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export function assertPublicAddresses(
  addresses: readonly ResolvedAddress[],
): void {
  if (addresses.length === 0) {
    throw new MonitorUrlPolicyError(
      "The hostname did not resolve to any IP addresses.",
    );
  }

  for (const { address } of addresses) {
    if (!isPublicRoutableAddress(address)) {
      throw new MonitorUrlPolicyError(
        "The hostname resolves to a non-public IP address.",
      );
    }
  }
}

export async function resolvePublicMonitorHostname(
  url: URL,
  dnsLookup: DnsLookup = systemDnsLookup,
): Promise<readonly ResolvedAddress[]> {
  let addresses: readonly ResolvedAddress[];

  try {
    addresses = await dnsLookup(url.hostname); // hostname doesn't get the port: https:example.com/81 -> example.com
  } catch {
    throw new MonitorUrlPolicyError("The hostname could not be resolved.");
  }

  assertPublicAddresses(addresses);

  return addresses.map(({ address }) => {
    const parsed = ipaddr.process(address);

    return {
      address: parsed.toString(),
      family: parsed.kind() === "ipv4" ? 4 : 6,
    };
  });
}

export { MonitorUrlPolicyError };
