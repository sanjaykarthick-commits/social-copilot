"use client";

import { mutate } from "swr";
import { api } from "@/lib/client/api";
import type { PostDTO } from "@/lib/posts-query";

/** Re-fetch every cached list/detail/analytics query after a change. */
export const refreshPosts = () =>
  mutate((key) => typeof key === "string" && (key.startsWith("/api/posts") || key.startsWith("/api/analytics")));

export async function publishNow(id: string) {
  const res = await api<{ post: PostDTO }>(`/api/posts/${id}/publish`, { method: "POST" });
  await refreshPosts();
  return res.post;
}

export async function deletePostById(id: string, opts: { fromPlatforms?: boolean } = {}) {
  await api(`/api/posts/${id}${opts.fromPlatforms ? "?fromPlatforms=1" : ""}`, { method: "DELETE" });
  await refreshPosts();
}

export async function moveScheduledPost(id: string, scheduledAt: Date) {
  const res = await api<{ post: PostDTO }>(`/api/posts/${id}`, { method: "PATCH", json: { scheduledAt: scheduledAt.toISOString() } });
  return res.post;
}

/** A post can be edited while nothing about it has gone out yet. */
export function canEdit(post: Pick<PostDTO, "status" | "targets">): boolean {
  if (post.status === "draft" || post.status === "scheduled") return true;
  return post.status === "failed" && !post.targets.some((t) => t.status === "published");
}

export const hasAnyPublished = (post: Pick<PostDTO, "targets">) => post.targets.some((t) => t.status === "published");

/** Time that best describes when the post is/was due. */
export const postWhen = (post: Pick<PostDTO, "scheduledAt" | "publishedAt">): Date | null => {
  const iso = post.scheduledAt ?? post.publishedAt;
  return iso ? new Date(iso) : null;
};
