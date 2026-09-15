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
          <h2>{launchRelease.title}</h2>
          <p className="release-intro">{launchRelease.summary}</p>
          <div className="release-sections">
            {launchRelease.sections.map((section) => (
              <section key={section.title}>
                <h3>{section.title}</h3>
                <ul>
                  {section.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </section>
            ))}
          </div>
          <section className="release-compatibility">
            <h3>Compatibility notes</h3>
            <ul>
              {launchRelease.compatibility.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
          <section className="release-availability">
            <h3>Release availability</h3>
            <p>
              These notes describe the current v8 beta source. No public artifact
              is attached to this repository state, so sndbox does not present
              this version as a downloadable release yet.
            </p>
            <Link href="/downloads">Check available builds <ArrowRight size={13} /></Link>
          </section>
        </div>
      </article>
    </main>
  );
}
