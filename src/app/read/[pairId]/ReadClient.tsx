"use client";
import { useParams } from "next/navigation";
import Auth from "@/components/Auth";
import Reader from "@/components/Reader";
import { useSession } from "@/components/useSession";

export default function ReadClient() {
  const { pairId } = useParams<{ pairId: string }>();
  const session = useSession();
  if (session === undefined) return null;
  if (!session) return <Auth />;
  return <Reader pairId={pairId} />;
}
