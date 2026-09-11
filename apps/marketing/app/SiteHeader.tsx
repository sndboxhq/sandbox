"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Download,
  Menu,
  X,
} from "lucide-react";
import { brand } from "@sandbox/brand";
import { SndboxMark } from "@sandbox/product-ui/brand";
import styles from "./SiteHeader.module.css";

type NavigationItem = {
  label: string;
  description: string;
  href: string;
  external?: boolean;
};

type NavigationGroup = {
  id: string;
  label: string;
  sections: Array<{
    label: string;
    items: NavigationItem[];
  }>;
};

const navigationGroups: NavigationGroup[] = [
  {
    id: "product",
    label: "Product",
    sections: [
      {
        label: "Build",
        items: [
          { label: "Visual builder", description: "Connect typed steps on one inspectable canvas.", href: "/product/visual-workflow-builder" },
          { label: "Browser automation", description: "Record browser work and keep every step editable.", href: "/product/browser-automation" },
          { label: "Local automation", description: "Work with files, commands and private services.", href: "/product/local-automation" },
        ],
      },
      {
        label: "Operate",
        items: [
          { label: "Always-on execution", description: "Run published workflows on durable infrastructure.", href: "/product/always-on-execution" },
          { label: "Teams & governance", description: "Control publication, roles and shared connections.", href: "/product/teams-governance" },
          { label: "Security", description: "Review the boundaries that protect each run.", href: "/security" },
        ],
      },
      {
        label: "Extend",
        items: [
          { label: "Marketplace", description: "Browse reviewed plugins and inspect their permissions.", href: "/marketplace" },
          { label: "Plugin system", description: "Install versioned capabilities with explicit permissions.", href: "/product/plugins-marketplace" },
          { label: "Developer platform", description: "Build nodes and operate against typed contracts.", href: "/developers" },
          { label: "Integrations", description: "Browse available plugins, nodes and permissions.", href: "/integrations" },
        ],
      },
    ],
  },
  {
    id: "solutions",
    label: "Solutions",
    sections: [
      {
        label: "Everyday operations",
        items: [
          { label: "Report collection", description: "Collect and verify reports before the day starts.", href: "/solutions/report-collection" },
          { label: "File & folder work", description: "Organise local files without uploading their contents.", href: "/solutions/file-folder-automation" },
          { label: "Browser routines", description: "Turn repeated browser work into a visible route.", href: "/solutions/browser-automation" },
        ],
      },
      {
        label: "Technical teams",
        items: [
          { label: "Developer workflows", description: "Join scripts, APIs and decisions in one run.", href: "/solutions/developer-workflows" },
          { label: "Website monitoring", description: "Check important pages and act only on changes.", href: "/solutions/website-monitoring" },
          { label: "Homelab automation", description: "Reach services that stay inside your network.", href: "/solutions/homelab-automation" },
        ],
      },
      {
        label: "Browse",
        items: [
          { label: "All solutions", description: "Start with the job you need to get done.", href: "/solutions" },
        ],
      },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    sections: [
      {
        label: "Learn",
        items: [
          { label: "Documentation", description: "Set up, build and troubleshoot workflows.", href: `${brand.domains.docs}/getting-started`, external: true },
          { label: "Join Discord", description: "Meet the community, share workflows and get help.", href: brand.community.discord, external: true },
          { label: "Support centre", description: "Find downloads, diagnostics and human support.", href: "/support" },
          { label: "Latest news", description: "Read product notes from the current desktop beta.", href: "/news" },
          { label: "Changelog", description: "See what changed and what to verify.", href: "/changelog" },
        ],
      },
      {
        label: "For organisations",
        items: [
          { label: "Enterprise", description: "Identity, policy and infrastructure controls.", href: "/enterprise" },
          { label: "Contact", description: "Talk through security, rollout or deployment.", href: "/contact" },
        ],
      },
    ],
  },
];

function isPathActive(pathname: string, href: string) {
  if (!href.startsWith("/")) return false;
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationLink({
  item,
  pathname,
  onSelect,
  menuItem = false,
}: {
  item: NavigationItem;
  pathname: string;
  onSelect: () => void;
  menuItem?: boolean;
}) {
  const active = isPathActive(pathname, item.href);
  const content = (
    <>
      <span>{item.label}{item.external && <ArrowUpRight aria-hidden="true" size={12} />}</span>
      <small>{item.description}</small>
    </>
  );

  if (item.external) {
    return <a href={item.href} role={menuItem ? "menuitem" : undefined} onClick={onSelect}>{content}</a>;
  }

  return (
    <Link
      href={item.href}
      role={menuItem ? "menuitem" : undefined}
      aria-current={active ? "page" : undefined}
      data-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      {content}
    </Link>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const wordmark = pathname === "/legal" || pathname.startsWith("/legal/") ? "sndbox legal" : "sndbox";
  const headerRef = useRef<HTMLElement>(null);
  const menuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobilePanelRef = useRef<HTMLElement>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileSection, setMobileSection] = useState<string | null>("product");
  const [scrolled, setScrolled] = useState(false);

  const cancelMenuClose = () => {
    if (menuCloseTimerRef.current === null) return;
    clearTimeout(menuCloseTimerRef.current);
    menuCloseTimerRef.current = null;
  };

  const openDesktopMenu = (groupId: string) => {
    cancelMenuClose();
    setOpenMenu(groupId);
  };

  const closeDesktopMenu = () => {
    cancelMenuClose();
    setOpenMenu(null);
  };

  const scheduleMenuClose = () => {
    cancelMenuClose();
    menuCloseTimerRef.current = setTimeout(() => {
      setOpenMenu(null);
      menuCloseTimerRef.current = null;
    }, 240);
  };

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 18);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => {
    cancelMenuClose();
    setOpenMenu(null);
    setMobileOpen(false);
    const activeGroup = navigationGroups.find((group) =>
      group.sections.some((section) => section.items.some((item) => isPathActive(pathname, item.href))),
    );
    setMobileSection(activeGroup?.id ?? (pathname === "/" ? "product" : null));
  }, [pathname]);

  useEffect(() => () => cancelMenuClose(), []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        closeDesktopMenu();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => mobileCloseRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        window.requestAnimationFrame(() => mobileButtonRef.current?.focus());
        return;
      }

      if (event.key !== "Tab" || !mobilePanelRef.current) return;
      const focusable = Array.from(
        mobilePanelRef.current.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileOpen]);

  const closeMobile = (restoreFocus = false) => {
    setMobileOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => mobileButtonRef.current?.focus());
  };

  const focusMenuItem = (menuId: string, edge: "first" | "last") => {
    window.requestAnimationFrame(() => {
      const items = document.querySelectorAll<HTMLElement>(`#${menuId} [role='menuitem']`);
      items[edge === "first" ? 0 : items.length - 1]?.focus();
    });
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLElement>, groupId: string) => {
    const menuId = `desktop-menu-${groupId}`;
    const items = Array.from(document.querySelectorAll<HTMLElement>(`#${menuId} [role='menuitem']`));
    const index = items.indexOf(document.activeElement as HTMLElement);

    if (event.key === "Escape") {
      event.preventDefault();
      setOpenMenu(null);
      document.getElementById(`desktop-trigger-${groupId}`)?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <header
      ref={headerRef}
      className={styles.header}
      data-scrolled={scrolled ? "true" : "false"}
      data-mobile-open={mobileOpen ? "true" : "false"}
    >
      <div className={styles.inner}>
        <Link className={styles.wordmark} href="/" aria-label="sndbox home">
          <SndboxMark className={styles.mark} size={32} />
          <span>{wordmark}</span>
        </Link>

        <nav className={styles.desktopNav} aria-label="Primary navigation" onMouseLeave={scheduleMenuClose}>
          {navigationGroups.map((group) => {
            const active = group.sections.some((section) => section.items.some((item) => isPathActive(pathname, item.href)));
            const isOpen = openMenu === group.id;
            const menuId = `desktop-menu-${group.id}`;
            return (
              <div
                className={styles.navGroup}
                data-open={isOpen ? "true" : "false"}
                key={group.id}
                onMouseEnter={() => openDesktopMenu(group.id)}
                onMouseLeave={scheduleMenuClose}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeDesktopMenu();
                }}
              >
                <button
                  id={`desktop-trigger-${group.id}`}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  aria-controls={menuId}
                  data-active={active ? "true" : undefined}
                  onMouseEnter={() => openDesktopMenu(group.id)}
                  onClick={() => {
                    cancelMenuClose();
                    setOpenMenu(isOpen ? null : group.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      openDesktopMenu(group.id);
                      focusMenuItem(menuId, event.key === "ArrowDown" ? "first" : "last");
                    } else if (event.key === "Escape") {
                      closeDesktopMenu();
                    }
                  }}
                >
                  {group.label}<ChevronDown aria-hidden="true" size={13} />
                </button>
                <div
                  id={menuId}
                  className={styles.dropdown}
                  data-count={group.sections.length}
                  role="menu"
                  aria-label={`${group.label} navigation`}
                  onMouseEnter={cancelMenuClose}
                  onMouseLeave={scheduleMenuClose}
                  onKeyDown={(event) => onMenuKeyDown(event, group.id)}
                >
                  <div className={styles.dropdownSections} data-count={group.sections.length} role="none">
                    {group.sections.map((section, sectionIndex) => (
                      <section key={section.label} role="group" aria-labelledby={`desktop-section-${group.id}-${sectionIndex}`}>
                        <h2 id={`desktop-section-${group.id}-${sectionIndex}`}>{section.label}</h2>
                        {section.items.map((item) => (
                          <NavigationLink item={item} pathname={pathname} onSelect={() => setOpenMenu(null)} menuItem key={item.href} />
                        ))}
                      </section>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          <Link
            className={styles.directLink}
            data-active={isPathActive(pathname, "/pricing") ? "true" : undefined}
            aria-current={isPathActive(pathname, "/pricing") ? "page" : undefined}
            href="/pricing"
            onMouseEnter={closeDesktopMenu}
          >
            Pricing
          </Link>
        </nav>

        <div className={styles.actions}>
          <a className={styles.signIn} href={`${brand.domains.app}/sign-in`}>Sign in</a>
          <Link
            className={styles.primaryAction}
            href="/downloads"
            aria-current={isPathActive(pathname, "/downloads") ? "page" : undefined}
            data-active={isPathActive(pathname, "/downloads") ? "true" : undefined}
          >
            <span>Download</span><Download aria-hidden="true" size={13} />
          </Link>
          <button
            ref={mobileButtonRef}
            className={styles.menuButton}
            type="button"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMobileOpen((value) => !value)}
          >
            {mobileOpen ? <X aria-hidden="true" size={19} /> : <Menu aria-hidden="true" size={19} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <>
          <button className={styles.mobileBackdrop} type="button" aria-label="Close navigation" onClick={() => closeMobile(true)} />
          <aside ref={mobilePanelRef} id="mobile-navigation" className={styles.mobilePanel} role="dialog" aria-modal="true" aria-label="Mobile navigation">
            <header>
              <strong>Menu</strong>
              <button ref={mobileCloseRef} type="button" aria-label="Close navigation" onClick={() => closeMobile(true)}><X aria-hidden="true" size={20} /></button>
            </header>
            <nav aria-label="Mobile navigation">
              {navigationGroups.map((group) => {
                const expanded = mobileSection === group.id;
                return (
                  <section className={styles.mobileGroup} key={group.id}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`mobile-group-${group.id}`}
                      data-active={group.sections.some((section) => section.items.some((item) => isPathActive(pathname, item.href))) ? "true" : undefined}
                      onClick={() => setMobileSection(expanded ? null : group.id)}
                    >
                      <strong>{group.label}</strong><ChevronDown aria-hidden="true" size={16} />
                    </button>
                    <div id={`mobile-group-${group.id}`} hidden={!expanded}>
                      {group.sections.map((section) => (
                        <section key={section.label} aria-label={section.label}>
                          <h2>{section.label}</h2>
                          {section.items.map((item) => (
                            <NavigationLink item={item} pathname={pathname} onSelect={() => closeMobile()} key={item.href} />
                          ))}
                        </section>
                      ))}
                    </div>
                  </section>
                );
              })}
              <Link
                className={styles.mobileDirect}
                href="/pricing"
                aria-current={isPathActive(pathname, "/pricing") ? "page" : undefined}
                data-current={isPathActive(pathname, "/pricing") ? "true" : undefined}
                onClick={() => closeMobile()}
              >
                <strong>Pricing</strong><ArrowUpRight aria-hidden="true" size={16} />
              </Link>
            </nav>
            <footer>
              <a href={`${brand.domains.app}/sign-in`} onClick={() => closeMobile()}>Sign in</a>
              <Link href="/downloads" onClick={() => closeMobile()}>Download sndbox <Download aria-hidden="true" size={14} /></Link>
            </footer>
          </aside>
        </>
      )}
    </header>
  );
}
