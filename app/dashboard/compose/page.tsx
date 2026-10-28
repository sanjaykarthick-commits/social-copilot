import type { Metadata } from "next";
import { Composer } from "@/components/compose/composer";

export const metadata: Metadata = { title: "New post" };

// Reading searchParams makes this route dynamic, so the client composer can load the post being edited.
export default async function ComposePage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  return <Composer editId={edit} />;
}
