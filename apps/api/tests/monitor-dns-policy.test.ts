import { describe, expect, it, vi } from "vitest";

import {
  assertPublicAddresses,
  isPublicRoutableAddress,
  MonitorUrlPolicyError,
  resolvePublicMonitorHostname,
  type DnsLookup,
  type ResolvedAddress,
} from "../src/monitors/monitor-dns-policy.js";

describe("isPublicRoutableAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],

    ["10.0.0.1", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["224.0.0.1", false],

    ["::1", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["::ffff:192.168.1.1", false],

    ["not-an-ip", false],
  ])("classifies %s as public=%s", (address, expected) => {
    expect(isPublicRoutableAddress(address)).toBe(expected);
  });
});

describe("assertPublicAddresses", () => {
  it("accepts a list containing public addresses", () => {
    const addresses: ResolvedAddress[] = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];

    expect(() => assertPublicAddresses(addresses)).not.toThrow();
  });

  it("rejects a mixture of public and private addresses", () => {
    const addresses: ResolvedAddress[] = [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ];

    expect(() => assertPublicAddresses(addresses)).toThrow(
      MonitorUrlPolicyError,
    );
  });

  it("rejects an empty result", () => {
    expect(() => assertPublicAddresses([])).toThrow(MonitorUrlPolicyError);
  });
});

describe("resolvePublicMonitorHostname", () => {
  it("resolves and validates all returned addresses", async () => {
    const dnsLookup: DnsLookup = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 },
    ]);

    const result = await resolvePublicMonitorHostname(
      new URL("https://example.com"),
      dnsLookup,
    );

    expect(dnsLookup).toHaveBeenCalledWith("example.com");
    expect(result).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("rejects a hostname that resolves to an internal address", async () => {
    const dnsLookup: DnsLookup = async () => [
      { address: "127.0.0.1", family: 4 },
    ];

    await expect(
      resolvePublicMonitorHostname(new URL("https://example.com"), dnsLookup),
    ).rejects.toThrow(MonitorUrlPolicyError);
  });

  it("rejects failed DNS resolution", async () => {
    const dnsLookup: DnsLookup = async () => {
      throw new Error("DNS resolution failed");
    };

    await expect(
      resolvePublicMonitorHostname(new URL("https://example.com"), dnsLookup),
    ).rejects.toThrow("The hostname could not be resolved.");
  });
});
