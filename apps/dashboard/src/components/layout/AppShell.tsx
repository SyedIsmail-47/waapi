import { NavLink, Outlet } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";

const links = [
  { to: "/sessions", label: "Sessions" },
  { to: "/messages", label: "Messages" },
  { to: "/settings", label: "Settings" },
  { to: "/settings/billing", label: "Billing" },
  { to: "/settings/tokens", label: "API tokens" },
];

export function AppShell() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[220px_1fr]">
      <aside className="border-b border-line bg-panel lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4 lg:block">
          <p className="font-display text-2xl tracking-tight text-ink">{BRAND_NAME}</p>
          <div className="lg:mt-4">
            <ThemeToggle />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-3 lg:flex-col lg:px-3" aria-label="Main">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                cn(
                  "px-3 py-2 text-sm text-muted hover:bg-accent-soft hover:text-ink",
                  isActive && "bg-accent-soft font-medium text-ink",
                )
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="px-4 py-6 sm:px-8">
        <Outlet />
      </main>
    </div>
  );
}
