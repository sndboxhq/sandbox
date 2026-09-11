import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Braces,
  Laptop,
  ScanSearch,
  Share2,
} from "lucide-react";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Latest news",
  description:
    "Product notes from sndbox: new desktop capabilities, workflow improvements, and the decisions behind them.",
  alternates: { canonical: "/news" },
};

const dispatches = [
  {
    id: "custom-functions",
    number: "01",
    area: "Editor",
    title: "Code at the scale you need.",
    description:
      "The full-page ƒx editor brings JavaScript and Python source, typed ports, fixtures, coverage, and local verification into one focused surface.",
    detail:
      "Ctrl or Command plus the mouse wheel now scales source code and line numbers from 75% to 400%, while normal scrolling stays normal.",
    icon: Braces,
  },
  {
    id: "collaboration",
    number: "02",
    area: "Collaboration",
    title: "Share a canvas without sharing its secrets.",
    description:
      "Live workflow sharing now carries encrypted changes, presence, and selections between collaborators. The control plane stores server-sequenced ciphertext, not workflow contents.",
    detail:
      "A shared workflow arrives disabled and without local approvals, plugin credentials, or custom-function verification receipts.",
    icon: Share2,
  },
  {
    id: "windows",
    number: "03",
    area: "Windows",
    title: "Your workflows are closer at hand.",
    description:
      "The desktop beta adds .sndbox file opens, drag and drop, a quick launcher, configurable global shortcuts, and opt-in startup at sign-in.",
    detail:
      "Imported workflows are staged for review before they become part of the local workspace.",
    icon: Laptop,
  },
  {
    id: "execution-details",
    number: "04",
    area: "Execution",
    title: "Failure evidence is easier to read.",
    description:
      "Warnings, errors, logs, and execution data now use larger type in both the editor drawer and full run-history view.",
    detail:
      "The command console also stays open after help, keeping the recovery path available when a command needs another look.",
    icon: ScanSearch,
  },
] as const;

export default function NewsPage() {
  return (
    <main id="content" className={styles.page}>
      <header className={styles.masthead}>
        <p className="eyebrow"><span />Latest news</p>
        <div className={styles.mastheadGrid}>
          <h1>What’s moving<br />inside sndbox.</h1>
          <div>
            <p>
              Product notes from the desktop beta: what changed, why it matters,
              and where to look for the exact release state.
            </p>
            <span className={styles.edition}>Edition 001 · 11 September 2026</span>
          </div>
        </div>
      </header>

      <article className={styles.leadStory} aria-labelledby="lead-story-title">
        <figure className={styles.leadArtwork}>
          <Image
            src="/brand/version-8-welcome-v2.png"
            alt="Welcome to sndbox 8, the power-user release, over a connected workflow diagram."
            width={1672}
            height={941}
            sizes="(max-width: 820px) 100vw, 62vw"
            priority
          />
          <figcaption>
            <span>Featured</span>
            <time dateTime="2026-09-11">11 Sep 2026</time>
          </figcaption>
        </figure>
        <div className={styles.leadCopy}>
          <p className={styles.storyType}>Desktop beta · v0.8.0-beta.1</p>
          <h2 id="lead-story-title">sndbox 8 is taking shape.</h2>
          <p>
            This power-user preview brings the command surface, custom functions,
            Windows workflow entry points, and encrypted collaboration into the
            same inspectable desktop experience.
          </p>
          <p>
            It remains a source-state beta: the current repository does not attach
            a public download artifact. The changelog reports that distinction
            directly so an unfinished build is never presented as a release.
          </p>
          <div className={styles.leadActions}>
            <Link href="/changelog">Read the technical changelog <ArrowRight aria-hidden="true" size={15} /></Link>
            <Link href="/downloads">Check available builds <ArrowUpRight aria-hidden="true" size={14} /></Link>
          </div>
        </div>
      </article>

      <section className={styles.dispatches} aria-labelledby="dispatches-title">
        <header>
          <p>From the current build</p>
          <h2 id="dispatches-title">Four changes worth knowing.</h2>
        </header>
        <div className={styles.dispatchGrid}>
          {dispatches.map((dispatch) => {
            const Icon = dispatch.icon;
            return (
              <article id={dispatch.id} key={dispatch.id}>
                <div className={styles.dispatchMeta}>
                  <span>{dispatch.number}</span>
                  <span>{dispatch.area}</span>
                  <Icon aria-hidden="true" size={19} />
                </div>
                <h3>{dispatch.title}</h3>
                <p>{dispatch.description}</p>
                <small>{dispatch.detail}</small>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.followThrough} aria-labelledby="follow-through-title">
        <div>
          <p>Keep going</p>
          <h2 id="follow-through-title">The headline is only the start.</h2>
        </div>
        <nav aria-label="News follow-up links">
          <Link href="/changelog">
            <span><strong>Changelog</strong><small>Verified release state</small></span>
            <ArrowRight aria-hidden="true" size={17} />
          </Link>
          <a href="https://docs.sndbox.app/getting-started">
            <span><strong>Documentation</strong><small>Set up your first workflow</small></span>
            <ArrowUpRight aria-hidden="true" size={17} />
          </a>
          <Link href="/downloads">
            <span><strong>Downloads</strong><small>Available desktop builds</small></span>
            <ArrowRight aria-hidden="true" size={17} />
          </Link>
        </nav>
      </section>
    </main>
  );
}
