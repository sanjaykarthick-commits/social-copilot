import Link from "next/link";
import { Logo } from "@/components/layout/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getEnv } from "@/lib/env";

export function contactEmail(): string | null {
  return getEnv().NEXT_PUBLIC_CONTACT_EMAIL ?? null;
}

export function Contact() {
  const email = contactEmail();
  return email ? (
    <a href={`mailto:${email}`} className="text-primary underline underline-offset-4">
      {email}
    </a>
  ) : (
    <span>the contact address published by the operator of this site</span>
  );
}

/** Plain, readable layout for the privacy, terms and data-deletion pages (public, no sign-in). */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-16 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm">Last updated {updated}</p>
        <div className="mt-8 space-y-6 text-[15px] leading-relaxed [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:space-y-1.5">{children}</div>
      </main>
      <footer className="text-muted-foreground mx-auto flex w-full max-w-3xl gap-4 px-4 py-6 text-sm sm:px-6">
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
