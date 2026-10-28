"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ChevronLeft, ChevronRight, FileText, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PostDrawer } from "@/components/posts/post-drawer";
import { PostRow } from "@/components/posts/post-row";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, fetcher } from "@/lib/client/api";
import { useTimezone } from "@/lib/client/hooks";
import { useDebounced } from "@/lib/client/use-debounced";
import { POST_STATUSES, PLATFORMS } from "@/lib/constants";
import { PLATFORM_META } from "@/lib/platforms/meta";
import type { PostDTO } from "@/lib/posts-query";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 15;
const TABS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Failed" },
] as const;

export function PostsView({ initialStatus }: { initialStatus?: string }) {
  const { tz } = useTimezone();
  const [status, setStatus] = useState<string>((POST_STATUSES as readonly string[]).includes(initialStatus ?? "") ? initialStatus! : "all");
  const [platform, setPlatform] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDebounced(search.trim(), 300);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), order: status === "scheduled" ? "asc" : "desc" });
  if (status !== "all") params.set("status", status);
  if (platform) params.set("platform", platform);
  if (q) params.set("q", q);

  const { data, error, isLoading, mutate } = useSWR<{ posts: PostDTO[]; total: number }>(`/api/posts?${params}`, fetcher, {
    keepPreviousData: true,
    refreshInterval: (d) => (d?.posts.some((p) => p.status === "publishing") ? 3000 : 0),
  });

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = status !== "all" || platform !== "" || q !== "";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader
        title="All posts"
        description="Drafts, scheduled, published and failed posts in one place."
        actions={
          <Link href="/dashboard/compose" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
            <Plus aria-hidden /> New post
          </Link>
        }
      />

      <div className="space-y-3">
        <Tabs
          value={status}
          onValueChange={(v) => {
            setStatus(String(v));
            setPage(1);
          }}
        >
          <TabsList className="w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto sm:w-fit">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="px-3 py-1">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search post text"
              aria-label="Search posts"
              className="h-9 pl-8"
            />
          </div>
          <NativeSelect
            aria-label="Filter by platform"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              setPage(1);
            }}
          >
            <NativeSelectOption value="">All platforms</NativeSelectOption>
            {PLATFORMS.filter((p) => PLATFORM_META[p].implemented).map((p) => (
              <NativeSelectOption key={p} value={p}>
                {PLATFORM_META[p].name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      {error && (
        <div role="alert" className="border-destructive/40 flex items-center gap-3 rounded-xl border p-3 text-sm">
          <span className="flex-1">{errorMessage(error)}</span>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            Retry
          </Button>
        </div>
      )}

      {isLoading && !data && (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      )}

      {data && data.posts.length === 0 && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{filtered ? "No posts match" : "No posts yet"}</EmptyTitle>
            <EmptyDescription>{filtered ? "Try a different filter or search." : "Write your first post and schedule it to Instagram, YouTube or LinkedIn."}</EmptyDescription>
          </EmptyHeader>
          {!filtered && (
            <EmptyContent>
              <Link href="/dashboard/compose" className={cn(buttonVariants({ variant: "brand" }), "h-9 rounded-lg px-3")}>
                <Plus aria-hidden /> Create a post
              </Link>
            </EmptyContent>
          )}
        </Empty>
      )}

      {data && data.posts.length > 0 && (
        <>
          <ul className="space-y-2">
            {data.posts.map((p) => (
              <PostRow key={p.id} post={p} tz={tz} onOpen={setOpenId} />
            ))}
          </ul>
          <div className="text-muted-foreground flex items-center justify-between text-sm">
            <span>
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft aria-hidden />
              </Button>
              <span className="px-2 tabular-nums">
                {page} / {pages}
              </span>
              <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}

      <PostDrawer postId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
