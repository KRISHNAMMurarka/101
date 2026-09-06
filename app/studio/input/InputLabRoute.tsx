"use client";

import { useRouter } from "next/navigation";

import InputLab from "../../components/InputLab";
import { useSessionId } from "../../lib/session-id";

/**
 * The Input Lab had no route. It was reachable only as `view === "lab"` inside Launcher's state
 * union, so it had no URL, could not be linked to, and vanished entirely on a phone along with the
 * rest of the navigation.
 */
export default function InputLabRoute() {
  const router = useRouter();
  const sessionId = useSessionId();
  if (!sessionId) return <div className="route-loading" />;
  return <InputLab sessionId={sessionId} onConnect={() => router.push("/devices")} onExit={() => router.push("/")} />;
}
