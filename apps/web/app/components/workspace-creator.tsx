"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";

type Workspace = {
  id: string;
  name: string;
  createdAt: string;
};

type ApiResponse = {
  data?: Workspace;
  error?: {
    code?: string;
    message?: string;
  };
};

export function WorkspaceCreator() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setStatus("loading");
    setMessage("");
    setWorkspace(null);

    try {
      const token = await getToken();

      if (!token) {
        throw new Error("No active Clerk session was found.");
      }

      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

      const response = await fetch(`${apiUrl}/api/v1/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name }),
        cache: "no-store",
      });

      const body = (await response.json()) as ApiResponse;

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            `Workspace creation failed (HTTP ${response.status})`,
        );
      }

      if (!body.data) {
        throw new Error("The API returned no workspace data.");
      }

      setWorkspace(body.data);
      setName("");
      setStatus("success");
      setMessage("Workspace created successfully!");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.",
      );
    }
  }

  if (!isLoaded || !isSignedIn) {
    return null;
  }

  return (
    <section className="mt-6 w-full max-w-lg space-y-4 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">Create a workspace</h2>

      <p className="text-sm text-gray-600">
        Create a workspace to organise your website monitors.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="workspace-name" className="block text-sm font-medium">
          Workspace name
        </label>

        <input
          id="workspace-name"
          name="name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          minLength={1}
          maxLength={100}
          required
          placeholder="My Engineering Team"
          className="w-full rounded-lg border px-3 py-2"
        />

        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {status === "loading" ? "Creating..." : "Create workspace"}
        </button>
      </form>

      {message && (
        <p
          role="status"
          className={status === "error" ? "text-sm text-red-600" : "text-sm"}
        >
          {message}
        </p>
      )}

      {workspace && (
        <div className="break-all rounded-lg bg-gray-50 p-3 text-sm">
          <p>
            <strong>Name:</strong> {workspace.name}
          </p>
          <p>
            <strong>Workspace ID:</strong> {workspace.id}
          </p>
          <p>
            <strong>Created:</strong>{" "}
            {new Date(workspace.createdAt).toLocaleString()}
          </p>
        </div>
      )}
    </section>
  );
}
