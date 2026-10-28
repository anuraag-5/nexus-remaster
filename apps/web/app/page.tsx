import { WorkspaceList } from "./components/workspace-list";
import { MonitorManager } from "./components/monitor-manager";
import { ApiSessionCheck } from "./components/api-session-check";
import { WorkspaceCreator } from "./components/workspace-creator";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold">Nexus</h1>
        <p className="mt-3 text-gray-600">
          Website Monitoring &amp; Reliability Platform
        </p>
      </div>

      <Show when="signed-out">
        <p>Sign in or create an account to get started.</p>

        <div className="flex gap-4">
          <SignInButton mode="modal">
            <button className="rounded-lg border px-5 py-2">Sign in</button>
          </SignInButton>

          <SignUpButton mode="modal">
            <button className="rounded-lg bg-black px-5 py-2 text-white">
              Create account
            </button>
          </SignUpButton>
        </div>
      </Show>

      <Show when="signed-in">
        <p>You're signed in to Nexus.</p>
        <UserButton />
        <ApiSessionCheck />
        <WorkspaceCreator />
        <WorkspaceList />
        <MonitorManager />
      </Show>
    </main>
  );
}
