import type { Metadata } from "next";
import { PostsView } from "@/components/posts/posts-view";

export const metadata: Metadata = { title: "All posts" };

export default async function PostsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  return <PostsView initialStatus={status} />;
}
