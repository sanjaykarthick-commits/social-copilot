import Link from "next/link";
import { ArrowRight, CalendarDays, Layers, LineChart, MessageCircle } from "lucide-react";
import { Show } from "@clerk/nextjs";
import { Logo } from "@/components/layout/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { PlatformGlyph } from "@/components/platform-icon";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POINTS = [
  { icon: Layers, title: "Write once, post everywhere", body: "Pick several accounts, tailor the text per platform, and see a live preview of each." },
  { icon: CalendarDays, title: "A calendar you can drag", body: "See every scheduled and published post by month, week or day. Drag a post to move it." },
  { icon: LineChart, title: "See how it did", body: "Likes, comments and views per post and per platform, next to what is scheduled." },
  { icon: MessageCircle, title: "Answer every comment", body: "Comments from Instagram, YouTube and LinkedIn land in one inbox. Reply in a click." },
];

export default function Home() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Show when="signed-out">
            <Link href="/sign-in" className={buttonVariants({ variant: "ghost" })}>
              Sign in
            </Link>
            <Link href="/sign-up" className={cn(buttonVariants({ variant: "brand" }), "h-8 rounded-lg px-3")}>
              Get started
            </Link>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard" className={cn(buttonVariants({ variant: "brand" }), "h-8 rounded-lg px-3")}>
              Dashboard
            </Link>
          </Show>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-12 px-4 py-12 sm:px-6">
        <section className="max-w-3xl space-y-6">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            Schedule once. <span className="text-brand">Publish everywhere.</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl text-lg text-pretty">
            Plan your week for Instagram, YouTube and LinkedIn on one calendar. Social Copilot publishes at the right time, shows how each post did, and brings every comment into one inbox.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/sign-up" className={cn(buttonVariants({ variant: "brand", size: "lg" }), "h-11 rounded-xl px-5 text-base")}>
              Start scheduling <ArrowRight aria-hidden />
            </Link>
            <div className="text-muted-foreground flex items-center gap-3 text-xl" aria-label="Supported platforms: Instagram, YouTube, LinkedIn, X">
              <PlatformGlyph platform="instagram" />
              <PlatformGlyph platform="youtube" />
              <PlatformGlyph platform="linkedin" />
              <PlatformGlyph platform="twitter" />
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-card rounded-2xl border p-5">
              <span className="bg-accent text-accent-foreground mb-3 flex size-9 items-center justify-center rounded-xl">
                <Icon className="size-4" aria-hidden />
              </span>
              <h2 className="font-semibold">{title}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap gap-x-5 gap-y-2 px-4 py-6 text-sm sm:px-6">
        <span>© {new Date().getFullYear()} Social Copilot</span>
        <Link href="/privacy" className="hover:text-foreground">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-foreground">
          Terms
        </Link>
        <Link href="/data-deletion" className="hover:text-foreground">
          Data deletion
        </Link>
      </footer>
    </div>
  );
}
