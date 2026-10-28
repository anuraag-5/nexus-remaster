import { describe, expect, it } from "vitest";

import {
  MonitorUrlPolicyError,
  parseMonitorUrlCandidate,
} from "../src/monitors/monitor-url-policy.js";

describe("parseMonitorUrlCandidate", () => {
  it.each([
    {
      input: "https://example.com",
      expectedHostname: "example.com",
    },
    {
      input: "http://status.example.com/health",
      expectedHostname: "status.example.com",
    },
    {
      input: "https://example.com:443",
      expectedHostname: "example.com",
    },
    {
      input: "http://example.com:80",
      expectedHostname: "example.com",
    },
  ])("accepts a supported URL: $input", ({ input, expectedHostname }) => {
    const result = parseMonitorUrlCandidate(input);

    expect(["http:", "https:"]).toContain(result.protocol);
    expect(result.hostname).toBe(expectedHostname);
  });

  it.each([
    "not-a-url",
    "ftp://example.com",
    "http://localhost",
    "http://127.0.0.1",
    "http://2130706433",
    "http://[::1]",
    "http://service.internal",
    "https://user:pass@example.com",
    "https://example.com:8443",
  ])("rejects an unsupported URL: %s", (input) => {
    expect(() => parseMonitorUrlCandidate(input)).toThrow(
      MonitorUrlPolicyError,
    );
  });

  it("removes URL fragments", () => {
    const result = parseMonitorUrlCandidate(
      "https://example.com/health#section",
    );

    expect(result.hash).toBe("");
    expect(result.pathname).toBe("/health");
  });
});
