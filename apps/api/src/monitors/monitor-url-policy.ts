import { isIP } from "node:net";

export class MonitorUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorUrlPolicyError";
  }
}

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".test",
  ".home.arpa",
  ".lan",
] as const;

export function parseMonitorUrlCandidate(input: string): URL {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new MonitorUrlPolicyError("The URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MonitorUrlPolicyError("Only HTTP and HTTPS URLs are supported.");
  }

  if (url.username || url.password) {
    throw new MonitorUrlPolicyError(
      "URLs containing credentials are not allowed.",
    );
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");

  if (!hostname || !hostname.includes(".")) {
    throw new MonitorUrlPolicyError("A fully qualified hostname is required.");
  }

  if (isIP(hostname) !== 0) {
    throw new MonitorUrlPolicyError("IP-literal URLs are not supported yet.");
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new MonitorUrlPolicyError(
      "Local and internal hostnames are not allowed.",
    );
  }

  if (url.port !== "") {
    throw new MonitorUrlPolicyError(
      "Only the standard HTTP and HTTPS ports are supported.",
    );
  }

  // Fragments are never sent as part of an HTTP request.
  url.hostname = hostname;
  url.hash = "";

  return url;
}