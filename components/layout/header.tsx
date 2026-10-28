"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, Plus } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Logo } from "@/components/layout/logo";
import { NavLinks } from "@/components/layout/nav-links";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";

export function Header() {
  const [open, setOpen] = useState(false);
  return (
    <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur sm:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
        <Menu aria-hidden />
      </Button>
      <Logo href="/dashboard" className="lg:hidden" />
      <div className="ml-auto flex items-center gap-2">
        <Link
          href="/dashboard/compose"
          className={cn(buttonVariants({ variant: "brand" }), "hidden h-8 rounded-lg px-3 sm:inline-flex lg:hidden")}
        >
          <Plus aria-hidden /> New post
        </Link>
        <ThemeToggle />
        <UserButton />
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="bg-sidebar p-4">
          <SheetHeader className="p-0">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Dashboard navigation</SheetDescription>
            <Logo href="/dashboard" />
          </SheetHeader>
          <NavLinks onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  );
}
