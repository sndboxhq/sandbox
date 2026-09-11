import { launchRelease } from "@sandbox/content";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata = {
  title: "Changelog",
  description: "The version and release availability represented by this sndbox repository.",
};

export default function Page() {
  return (
    <main id="content" className="index-page changelog-page">
      <header>
        <p className="eyebrow"><span />Changelog</p>
        <h1>The state of<br />this build.</h1>
        <p>This page reports only what the checked-out repository can verify.</p>
      </header>
      <article className="release">
        <aside>
          <strong>v{launchRelease.version.replace(/^v/, "")}</strong>
          <span>{launchRelease.channel}</span>
          <span>{launchRelease.date}</span>
        </aside>
        <div>
          <h2>Current source snapshot</h2>
          <p>{launchRelease.summary}</p>
          <h3>Release availability</h3>
          <p>
            No public artifact is attached to this source state. sndbox therefore
            does not present this version as a downloadable release.
          </p>
          <Link href="/downloads">Check available builds <ArrowRight size={13} /></Link>
        </div>
      </article>
    </main>
  );
}
