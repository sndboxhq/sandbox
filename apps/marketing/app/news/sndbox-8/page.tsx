import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "sndbox 8 is taking shape",
  description:
    "Inside the sndbox 8 desktop beta: the command surface, custom functions, encrypted collaboration, and new Windows entry points.",
  alternates: { canonical: "/news/sndbox-8" },
};

const contents = [
  ["command-surface", "A command surface beside the canvas"],
  ["custom-functions", "Custom functions get a full page"],
  ["collaboration", "Shared work, local trust"],
  ["windows", "Windows entry points"],
  ["beta", "What the beta label means"],
] as const;

export default function SndboxEightNewsPage() {
  return (
    <main id="content" className={styles.page}>
      <article>
        <header className={styles.articleHeader}>
          <Link className={styles.backLink} href="/news"><ArrowLeft aria-hidden="true" size={15} />All news</Link>
          <div className={styles.articleMeta}>
            <span>Desktop beta</span>
            <time dateTime="2026-09-11">11 September 2026</time>
            <span>6 min read</span>
          </div>
          <h1>sndbox 8 is<br />taking shape.</h1>
          <p>
            The power-user preview brings more of the work into view—commands,
            code, collaboration, and the Windows paths that get a workflow moving.
          </p>
        </header>

        <figure className={styles.heroArtwork}>
          <Image
            src="/brand/version-8-welcome-v2.png"
            alt="Welcome to sndbox 8, the power-user release, over a connected workflow diagram."
            width={1672}
            height={941}
            sizes="(max-width: 1360px) 100vw, 1312px"
            priority
          />
          <figcaption>The current desktop work is collected in v8.0.0-beta.1.</figcaption>
        </figure>

        <div className={styles.articleLayout}>
          <aside>
            <strong>In this story</strong>
            <nav aria-label="Article contents">
              {contents.map(([id, label], index) => (
                <a href={`#${id}`} key={id}><span>0{index + 1}</span>{label}</a>
              ))}
            </nav>
          </aside>

          <div className={styles.articleCopy}>
            <p className={styles.intro}>
              sndbox has always made a simple promise: the route your work takes
              should remain visible. Version 8 applies that idea to the parts of
              automation that usually disappear into a terminal, a script, or a
              collaboration service.
            </p>

            <section id="command-surface">
              <p className={styles.sectionNumber}>01 · Command surface</p>
              <h2>A command surface beside the canvas.</h2>
              <p>
                The new console is docked inside the desktop app and speaks only
                sndbox. It can navigate the product, find workflows, inspect runs,
                and call the same guarded actions as the graphical interface.
              </p>
              <p>
                It is resizable, searchable through command completion, and close
                enough to the canvas that keyboard-heavy work no longer means
                leaving the workflow behind. Help output now remains safely inside
                the console, too.
              </p>
            </section>

            <section id="custom-functions">
              <p className={styles.sectionNumber}>02 · Custom functions</p>
              <h2>Custom functions get room to breathe.</h2>
              <p>
                A custom ƒx node now opens as a full-page JavaScript or Python
                editor. Inputs, outputs, and branches are explicit. Fixtures show
                what the function should receive and return, while coverage and a
                verification receipt show what has actually been tested.
              </p>
              <blockquote>
                Custom functions remain local-desktop work. Their runtime cannot
                reach the filesystem, network, environment, credentials, browser,
                or plugins.
              </blockquote>
              <p>
                The code surface also follows the reader: Ctrl or Command plus the
                mouse wheel scales source and line numbers from 75% to 400% without
                changing ordinary scrolling.
              </p>
            </section>

            <section id="collaboration">
              <p className={styles.sectionNumber}>03 · Collaboration</p>
              <h2>Shared work does not inherit local trust.</h2>
              <p>
                Live sharing carries encrypted workflow edits, presence, and
                selections between collaborators. The service sequences ciphertext;
                it does not need the plaintext workflow to coordinate the session.
              </p>
              <p>
                When a shared workflow reaches another device it starts disabled,
                without approvals, plugin credential references, or custom-function
                verification receipts. Collaboration can move the design. Each
                machine still decides what it is willing to run.
              </p>
            </section>

            <section id="windows">
              <p className={styles.sectionNumber}>04 · Windows</p>
              <h2>More direct ways into a workflow.</h2>
              <p>
                Version 8 adds .sndbox file opens, drag and drop, legacy import,
                a quick launcher, configurable global shortcuts, and opt-in startup
                at sign-in. Imports are staged for review so opening a file does not
                silently turn it into an active workflow.
              </p>
            </section>

            <section id="beta">
              <p className={styles.sectionNumber}>05 · Release state</p>
              <h2>Beta still means beta.</h2>
              <p>
                The repository identifies this work as v8.0.0-beta.1, but the
                current source state does not attach a public download artifact.
                The changelog and downloads page report that distinction directly.
              </p>
              <div className={styles.articleActions}>
                <Link href="/changelog">Check the release state <ArrowRight aria-hidden="true" size={15} /></Link>
                <Link href="/downloads">View available builds <ArrowUpRight aria-hidden="true" size={14} /></Link>
              </div>
            </section>
          </div>
        </div>
      </article>
    </main>
  );
}
