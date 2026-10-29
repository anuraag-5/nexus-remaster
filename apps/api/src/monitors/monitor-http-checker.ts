import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";

import {
  MonitorUrlPolicyError,
  parseMonitorUrlCandidate,
} from "./monitor-url-policy.js";
import {
  resolvePublicMonitorHostname,
  type DnsLookup,
  type ResolvedAddress,
} from "./monitor-dns-policy.js";

export type PinnedHttpResponse = Readonly<{
  statusCode: number;
  headers: IncomingHttpHeaders;
}>;

export type PinnedRequest = (
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
) => Promise<PinnedHttpResponse>;

export type MonitorHttpCheckResult = Readonly<{
  status: "up" | "down";
  checkedAt: string;
  completedAt: string;
  responseTimeMs: number;
  httpStatusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  redirectCount: number;
}>;

type CheckerOptions = {
  timeoutMs?: number;
  maxRedirects?: number;
  dnsLookup?: DnsLookup;
  requestOnce?: PinnedRequest;
};

class MonitorTransportError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "NETWORK_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "MonitorTransportError";
  }
}

class MonitorCheckFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MonitorCheckFailure";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Connect to a previously validated IP address.
 *
 * Keep the original domain in the Host header and, for HTTPS,
 * use that domain for SNI and certificate hostname verification.
 */
const requestPinnedAddress: PinnedRequest = (url, address, timeoutMs) => {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      hostname: address.address,
      family: address.family,
      port:
        url.port !== ""
          ? Number(url.port)
          : url.protocol === "https:"
            ? 443
            : 80,
      method: "GET",
      path: `${url.pathname || "/"}${url.search}`,
      headers: {
        Host: url.host,
        "User-Agent": "NexusMonitor/1.0",
        Accept: "*/*",
        Connection: "close",
      },
      agent: false,
    };

    const onResponse = (response: IncomingMessage) => {
      if (timer) {
        clearTimeout(timer);
      }

      const result: PinnedHttpResponse = {
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
      };

      // We only need the response headers and status.
      // Do not download an arbitrary response body.
      response.destroy();

      resolve(result);
    };

    let request: ClientRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      if (url.protocol === "https:") {
        request = httpsRequest(
          {
            ...options,
            servername: url.host,
            rejectUnauthorized: true,
          },
          onResponse,
        );
      } else {
        request = httpRequest(options, onResponse);
      }
    } catch {
      reject(
        new MonitorTransportError(
          "NETWORK_ERROR",
          "The connection could not be started.",
        ),
      );
      return;
    }

    timer = setTimeout(() => {
      request.destroy(
        new MonitorTransportError("TIMEOUT", "The request timed out."),
      );
    }, timeoutMs);

    request.once("error", (error: Error) => {
      if (timer) {
        clearTimeout(timer);
      }

      if (error instanceof MonitorTransportError) {
        reject(error);
        return;
      }

      reject(
        new MonitorTransportError("NETWORK_ERROR", "The connection failed."),
      );
    });

    request.end();
  });
};

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MonitorTransportError(
          "TIMEOUT",
          "The check exceeded its time limit.",
        ),
      );
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function requestWithAddressFallback(
  url: URL,
  addresses: readonly ResolvedAddress[],
  deadline: number,
  requestOnce: PinnedRequest,
): Promise<PinnedHttpResponse> {
  let lastError: MonitorTransportError | undefined;

  for (const address of addresses) {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      throw new MonitorTransportError(
        "TIMEOUT",
        "The check exceeded its time limit.",
      );
    }

    try {
      return await requestOnce(url, address, remainingMs);
    } catch (error) {
      if (!(error instanceof MonitorTransportError)) {
        throw error;
      }

      lastError = error;

      // A timeout consumes the remaining time budget.
      if (error.code === "TIMEOUT") {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new MonitorTransportError(
      "NETWORK_ERROR",
      "No validated address could be reached.",
    )
  );
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof MonitorCheckFailure) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof MonitorUrlPolicyError) {
    const isDnsFailure = /could not be resolved|did not resolve/i.test(
      error.message,
    );

    return {
      code: isDnsFailure ? "DNS_LOOKUP_FAILED" : "URL_POLICY_REJECTED",
      message: error.message,
    };
  }

  if (error instanceof MonitorTransportError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  // Do not silently disguise programming bugs as website failures.
  throw error;
}

function makeResult(input: {
  startedAt: number;
  status: "up" | "down";
  httpStatusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  redirectCount: number;
}): MonitorHttpCheckResult {
  const completedAt = Date.now();

  return {
    status: input.status,
    checkedAt: new Date(input.startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    responseTimeMs: Math.max(0, completedAt - input.startedAt),
    httpStatusCode: input.httpStatusCode,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    redirectCount: input.redirectCount,
  };
}

export async function checkMonitorUrl(
  input: string,
  options: CheckerOptions = {},
): Promise<MonitorHttpCheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const dnsLookup = options.dnsLookup;
  const requestOnce = options.requestOnce ?? requestPinnedAddress;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new RangeError("timeoutMs must be between 1000 and 60000.");
  }

  if (
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 10
  ) {
    throw new RangeError("maxRedirects must be between 0 and 10.");
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  let redirectCount = 0;
  let lastHttpStatusCode: number | null = null;

  try {
    let currentUrl = parseMonitorUrlCandidate(input);

    while (true) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        throw new MonitorTransportError(
          "TIMEOUT",
          "The check exceeded its time limit.",
        );
      }

      // Resolve and validate all addresses before connecting.
      const addresses = await withTimeout(
        resolvePublicMonitorHostname(currentUrl, dnsLookup), // Default: True DNS lookup
        remainingMs,
      );

      // Each request connects to a validated address, rather
      // than resolving the hostname a second time.
      const response = await requestWithAddressFallback(
        currentUrl,
        addresses,
        deadline,
        requestOnce,
      );

      lastHttpStatusCode = response.statusCode;

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        const location = response.headers.location;

        if (typeof location === "string" && location.trim() !== "") {
          if (redirectCount >= maxRedirects) {
            throw new MonitorCheckFailure(
              "REDIRECT_LIMIT_EXCEEDED",
              "The redirect limit was exceeded.",
            );
          }

          let nextUrl: URL;

          try {
            nextUrl = parseMonitorUrlCandidate(
              new URL(location, currentUrl).toString(),
            );
          } catch {
            throw new MonitorCheckFailure(
              "REDIRECT_REJECTED",
              "The redirect target is invalid or not allowed.",
            );
          }

          // Do not follow HTTPS redirects down to plaintext HTTP.
          if (
            currentUrl.protocol === "https:" &&
            nextUrl.protocol === "http:"
          ) {
            throw new MonitorCheckFailure(
              "REDIRECT_REJECTED",
              "HTTPS-to-HTTP redirects are not allowed.",
            );
          }

          redirectCount += 1;
          currentUrl = nextUrl;
          continue;
        }
      }

      const isUp = response.statusCode >= 200 && response.statusCode < 400;

      return makeResult({
        startedAt,
        status: isUp ? "up" : "down",
        httpStatusCode: response.statusCode,
        errorCode: isUp ? null : "HTTP_ERROR",
        errorMessage: isUp
          ? null
          : `Received HTTP status ${response.statusCode}.`,
        redirectCount,
      });
    }
  } catch (error) {
    const failure = classifyFailure(error);

    return makeResult({
      startedAt,
      status: "down",
      httpStatusCode: lastHttpStatusCode,
      errorCode: failure.code,
      errorMessage: failure.message,
      redirectCount,
    });
  }
}
