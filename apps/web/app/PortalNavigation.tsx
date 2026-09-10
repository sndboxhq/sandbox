"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen,
  CreditCard,
  Download,
  Gauge,
  Gift,
  KeyRound,
  LifeBuoy,
  Menu,
  ReceiptText,
  Server,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { withWorkspaceContext } from "../lib/workspace-context";

const navigationGroups = [
  {
    label: "Workspace",
    links: [
      ["/", "Overview", Gauge],
      ["/organisations", "Workspaces", Users],
      ["/operations", "Operations", Server],
      ["/usage", "Usage", ReceiptText],
    ],
  },
  {
    label: "Account",
    links: [
      ["/billing", "Plan & billing", CreditCard],
      ["/referrals", "Referrals", Gift],
      ["/security", "Security & API", ShieldCheck],
      ["/settings", "Account settings", Settings],
    ],
  },
  {
    label: "Resources",
    links: [
      ["/downloads", "Downloads", Download],
      ["/releases", "Release notes", BookOpen],
      ["/support", "Help & support", LifeBuoy],
    ],
  },
] as const;

function NavigationLinks({ onNavigate, workspaceId }: { onNavigate?: () => void; workspaceId?: string }) {
  const pathname = usePathname();
  const explicitWorkspaceId = useSearchParams().get("workspaceId") ?? undefined;
  const contextWorkspaceId = explicitWorkspaceId ?? workspaceId;

  return (
    <nav className="portal-nav" aria-label="Account navigation">
      {navigationGroups.map((group) => (
        <div className="portal-nav-group" key={group.label}>
          <span>{group.label}</span>
          {group.links.map(([href, label, Icon]) => {
            const active = href === "/" ? pathname === href : pathname.startsWith(href);
            return (
              <Link href={withWorkspaceContext(href, contextWorkspaceId)} key={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={active ? "active" : undefined}>
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function PortalNavigation({ workspaceId }: { workspaceId?: string }) {
  return <NavigationLinks workspaceId={workspaceId} />;
}

export function PortalMobileNavigation() {
  const [open, setOpen] = useState(false);
  const workspaceId = useSearchParams().get("workspaceId") ?? undefined;

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="portal-mobile-navigation">
      <button
        className="portal-menu-trigger"
        type="button"
        aria-label={open ? "Close account navigation" : "Open account navigation"}
        aria-expanded={open}
        aria-controls="portal-mobile-panel"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X aria-hidden="true" size={18} /> : <Menu aria-hidden="true" size={18} />}
      </button>
      {open && (
        <>
          <button className="portal-menu-backdrop" type="button" aria-label="Close navigation" onClick={() => setOpen(false)} />
          <aside id="portal-mobile-panel" className="portal-mobile-panel" role="dialog" aria-modal="true" aria-label="Account navigation">
            <NavigationLinks onNavigate={() => setOpen(false)} workspaceId={workspaceId} />
            <form action="/auth/sign-out" method="post" className="mobile-signout">
              <button type="submit"><KeyRound aria-hidden="true" /> Sign out</button>
            </form>
          </aside>
        </>
      )}
    </div>
  );
}
