import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { brand } from "@sandbox/brand";
import { SndboxMark } from "@sandbox/product-ui/brand";
import styles from "./SiteFooter.module.css";

const footerGroups = [
  {
    label: "Product",
    links: [
      { label: "Visual builder", href: "/product/visual-workflow-builder" },
      { label: "Browser automation", href: "/product/browser-automation" },
      { label: "Local automation", href: "/product/local-automation" },
      { label: "Always-on execution", href: "/product/always-on-execution" },
    ],
  },
  {
    label: "Explore",
    links: [
      { label: "Solutions", href: "/solutions" },
      { label: "Marketplace", href: "/marketplace" },
      { label: "Pricing", href: "/pricing" },
      { label: "Changelog", href: "/changelog" },
      { label: "Discord community", href: brand.community.discord, external: true },
    ],
  },
  {
    label: "Company",
    links: [
      { label: "Security", href: "/security" },
      { label: "Enterprise", href: "/enterprise" },
      { label: "Support", href: "/support" },
      { label: "Contact", href: "/contact" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.cta}>
        <div>
          <p>Start with one useful routine</p>
          <h2>Put one routine<br />on a visible route.</h2>
        </div>
        <div>
          <p>Build locally, inspect every step and choose another runner only when the job calls for it.</p>
          <Link href="/downloads">Download sndbox <ArrowRight aria-hidden="true" size={15} /></Link>
        </div>
      </div>

      <div className={styles.directory}>
        <div className={styles.brand}>
          <Link href="/" aria-label="sndbox home"><SndboxMark size={29} />sndbox</Link>
          <p>Visual automation with a machine boundary you control.</p>
          <a href={brand.domains.docs + "/getting-started"}>Documentation <ArrowUpRight aria-hidden="true" size={12} /></a>
        </div>
        {footerGroups.map((group) => (
          <nav aria-label={group.label + " links"} key={group.label}>
            <h2>{group.label}</h2>
            {group.links.map((link) => (
              "external" in link
                ? <a href={link.href} key={link.href}>{link.label}</a>
                : <Link href={link.href} key={link.href}>{link.label}</Link>
            ))}
          </nav>
        ))}
      </div>

      <Link className={styles.display} href="/" aria-label="sndbox home">sndbox</Link>
      <div className={styles.legal}>
        <small>© 2026 sndbox. All rights reserved.</small>
        <div>
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
          <Link href="/legal/cookies">Cookies</Link>
          <Link href="/legal/refunds">Refunds</Link>
          <Link href="/legal/accessibility">Accessibility</Link>
        </div>
      </div>
    </footer>
  );
}
