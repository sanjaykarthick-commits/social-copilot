import { Logo } from "@/components/layout/logo";
import { NavLinks } from "@/components/layout/nav-links";

export function Sidebar() {
  return (
    <aside className="bg-sidebar sticky top-0 hidden h-svh w-64 shrink-0 flex-col gap-6 border-r p-4 lg:flex">
      <Logo href="/dashboard" className="px-1 pt-1" />
      <NavLinks />
    </aside>
  );
}
