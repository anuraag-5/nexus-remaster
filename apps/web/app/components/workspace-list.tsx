"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

type Workspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
};

type ApiResponse = {
  data?: Workspace[];
  error?: {
    code?: string;
    message?: string;
  };
};

export function WorkspaceList() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadWorkspaces() {
    setLoading(true);
    setMessage("");

    try {
      const token = await getToken();

      if (!token) {
        throw new Error("No active Clerk session found.");
      }

      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

      const response = await fetch(`${apiUrl}/api/v1/workspaces`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const body = (await response.json()) as ApiResponse;

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            `Failed to load workspaces (HTTP ${response.status})`,
        );
      }

      if (!Array.isArray(body.data)) {
        throw new Error("Unexpected workspace response from the API.");
      }

      setWorkspaces(body.data);
      setMessage(`Loaded ${body.data.length} workspace(s).`);
    } catch (error) {
      setWorkspaces(null);
      setMessage(
        error instanceof Error ? error.message : "Unable to load workspaces.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (!isLoaded || !isSignedIn) {
    return null;
  }

  return (
    <section className="mt-6 w-full max-w-lg space-y-4 rounded-xl border p-5">
      <div>
        <h2 className="text-lg font-semibold">My workspaces</h2>
        <p className="text-sm text-gray-600">
          View the workspaces associated with your account.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void loadWorkspaces()}
        disabled={loading}
        className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {loading ? "Loading..." : "Load my workspaces"}
      </button>

      {message && (
        <p role="status" className="text-sm" aria-live="polite">
          {message}
        </p>
      )}

      {workspaces !== null && workspaces.length === 0 && (
        <p className="text-sm text-gray-600">
          You haven't created any workspaces yet.
        </p>
      )}

      {workspaces !== null && workspaces.length > 0 && (
        <div className="space-y-3">
          {workspaces.map((workspace) => (
            <article
              key={workspace.id}
              className="break-all rounded-lg border p-4"
            >
              <h3 className="font-semibold">{workspace.name}</h3>

              <p className="mt-1 text-sm">
                Role: <strong>{workspace.role}</strong>
              </p>

              <p className="mt-1 text-sm text-gray-600">ID: {workspace.id}</p>

              <p className="mt-1 text-sm text-gray-600">
                Created: {new Date(workspace.createdAt).toLocaleString()}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
