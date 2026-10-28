import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { TimezoneSync } from "@/components/timezone-sync";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh">
      <TimezoneSync />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
