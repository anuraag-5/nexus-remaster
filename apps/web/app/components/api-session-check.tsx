"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

type ApiResponse = {
  userId?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

export function ApiSessionCheck() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  async function checkApi() {
    setStatus("loading");
    setMessage("");

    try {
      const token = await getToken();

      if (!token) {
        throw new Error("No Clerk session token is available.");
      }

      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

      const response = await fetch(`${apiUrl}/api/v1/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const body = (await response.json()) as ApiResponse;

      if (!response.ok) {
        throw new Error(
          body.error?.message ?? `API returned HTTP ${response.status}`,
        );
      }

      if (!body.userId) {
        throw new Error("API response did not contain a user ID.");
      }

      setMessage(`Authenticated successfully. User ID: ${body.userId}`);
      setStatus("success");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not connect to the Nexus API.",
      );
      setStatus("error");
    }
  }

  return (
    <section className="mt-6 space-y-3 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">Backend authentication test</h2>

      <p className="text-sm text-gray-600">
        Verify that your current Clerk session can authenticate with the Nexus
        Express API.
      </p>

      <button
        type="button"
        onClick={() => void checkApi()}
        disabled={!isLoaded || !isSignedIn || status === "loading"}
        className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {status === "loading" ? "Checking API..." : "Test API authentication"}
      </button>

      {message && (
        <p
          role="status"
          className={status === "error" ? "text-sm text-red-600" : "text-sm"}
        >
          {message}
        </p>
      )}
    </section>
  );
}
