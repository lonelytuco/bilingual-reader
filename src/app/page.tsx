"use client";
import Auth from "@/components/Auth";
import Library from "@/components/Library";
import { useSession } from "@/components/useSession";

export default function Home() {
  const session = useSession();
  if (session === undefined) return null;
  if (!session) return <Auth />;
  return <Library email={session.user.email ?? ""} />;
}
