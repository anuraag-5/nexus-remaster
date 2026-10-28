"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";

type Workspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
};

type Monitor = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  isEnabled: boolean;
  currentStatus: "unknown" | "up" | "down";
  nextCheckAt: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApiResponse<T> = {
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
};

async function readApiData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResponse<T>;

  if (!response.ok) {
    throw new Error(
      body.error?.message ?? `Request failed (HTTP ${response.status})`,
    );
  }

  if (body.data === undefined) {
    throw new Error("Unexpected response from the Nexus API.");
  }

  return body.data;
}

export function MonitorManager() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("300");

  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingMonitors, setLoadingMonitors] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

  async function getSessionToken() {
    const token = await getToken();

    if (!token) {
      throw new Error("No active Clerk session was found.");
    }

    return token;
  }

  async function loadWorkspaces() {
    setLoadingWorkspaces(true);
    setMessage("");
    setError("");

    try {
      const token = await getSessionToken();

      const response = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const data = await readApiData<Workspace[]>(response);

      setWorkspaces(data);

      setWorkspaceId((current) =>
        data.some((workspace) => workspace.id === current)
          ? current
          : (data[0]?.id ?? ""),
      );

      setMonitors(null);
      setMessage(
        data.length
          ? `Loaded ${data.length} workspace(s).`
          : "No workspaces found. Create a workspace first.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load workspaces.",
      );
    } finally {
      setLoadingWorkspaces(false);
    }
  }

  async function loadMonitors() {
    if (!workspaceId) {
      setError("Select a workspace first.");
      return;
    }

    setLoadingMonitors(true);
    setMessage("");
    setError("");

    try {
      const token = await getSessionToken();

      const response = await fetch(
        `${apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/monitors`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        },
      );

      const data = await readApiData<Monitor[]>(response);

      setMonitors(data);
      setMessage(`Loaded ${data.length} monitor(s).`);
    } catch (err) {
      setMonitors(null);
      setError(err instanceof Error ? err.message : "Failed to load monitors.");
    } finally {
      setLoadingMonitors(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspaceId) {
      setError("Select a workspace first.");
      return;
    }

    setCreating(true);
    setMessage("");
    setError("");

    try {
      const token = await getSessionToken();

      const response = await fetch(
        `${apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/monitors`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            url,
            intervalSeconds: Number(intervalSeconds),
            timeoutMs: 10000,
          }),
          cache: "no-store",
        },
      );

      const created = await readApiData<Monitor>(response);

      setName("");
      setUrl("");
      setMessage(`Monitor "${created.name}" created successfully.`);

      try {
        const listResponse = await fetch(
          `${apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/monitors`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: "no-store",
          },
        );

        setMonitors(await readApiData<Monitor[]>(listResponse));
      } catch {
        setMessage(
          `Monitor "${created.name}" was created. Reload the list to see it.`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create monitor.",
      );
    } finally {
      setCreating(false);
    }
  }

  if (!isLoaded || !isSignedIn) {
    return null;
  }

  return (
    <section className="mt-6 w-full max-w-2xl space-y-6 rounded-xl border p-5">
      <div>
        <h2 className="text-xl font-semibold">Website monitors</h2>
        <p className="mt-1 text-sm text-gray-600">
          Register websites and inspect their saved monitoring configuration.
        </p>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => void loadWorkspaces()}
          disabled={loadingWorkspaces}
          className="rounded-lg border px-4 py-2 disabled:opacity-50"
        >
          {loadingWorkspaces ? "Loading workspaces..." : "Load workspaces"}
        </button>

        {workspaces.length > 0 && (
          <div className="space-y-2">
            <label
              htmlFor="monitor-workspace"
              className="block text-sm font-medium"
            >
              Workspace
            </label>

            <select
              id="monitor-workspace"
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setMonitors(null);
                setMessage("");
                setError("");
              }}
              className="w-full rounded-lg border px-3 py-2"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} ({workspace.role})
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => void loadMonitors()}
              disabled={!workspaceId || loadingMonitors}
              className="rounded-lg border px-4 py-2 disabled:opacity-50"
            >
              {loadingMonitors ? "Loading monitors..." : "Load monitors"}
            </button>
          </div>
        )}
      </div>

      {workspaceId && (
        <form onSubmit={handleCreate} className="space-y-4 border-t pt-5">
          <h3 className="font-semibold">Add a monitor</h3>

          <div className="space-y-1">
            <label htmlFor="monitor-name" className="block text-sm font-medium">
              Monitor name
            </label>
            <input
              id="monitor-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
              placeholder="Production website"
              className="w-full rounded-lg border px-3 py-2"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="monitor-url" className="block text-sm font-medium">
              Website URL
            </label>
            <input
              id="monitor-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              maxLength={2048}
              placeholder="https://example.com/health"
              className="w-full rounded-lg border px-3 py-2"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="monitor-interval"
              className="block text-sm font-medium"
            >
              Check interval
            </label>
            <select
              id="monitor-interval"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              className="w-full rounded-lg border px-3 py-2"
            >
              <option value="300">5 minutes</option>
              <option value="60">1 minute</option>
              <option value="30">30 seconds</option>
            </select>
          </div>

          <p className="text-xs text-gray-500">
            These are currently configuration values. The monitoring scheduler
            has not been implemented yet.
          </p>

          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {creating ? "Creating monitor..." : "Create monitor"}
          </button>
        </form>
      )}

      {message && (
        <p role="status" className="text-sm text-green-700">
          {message}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {monitors !== null && (
        <div className="space-y-3 border-t pt-5">
          <h3 className="font-semibold">Monitors in this workspace</h3>

          {monitors.length === 0 && (
            <p className="text-sm text-gray-600">
              No monitors yet. Add your first monitor above.
            </p>
          )}

          {monitors.map((monitor) => (
            <article
              key={monitor.id}
              className="space-y-1 rounded-lg border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold">{monitor.name}</h4>
                <span className="rounded-full border px-2 py-1 text-xs">
                  {monitor.currentStatus}
                </span>
              </div>

              <p className="break-all text-sm text-gray-600">{monitor.url}</p>

              <p className="text-sm">
                Interval: {monitor.intervalSeconds} seconds
              </p>

              <p className="text-xs text-gray-500">Monitor ID: {monitor.id}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}