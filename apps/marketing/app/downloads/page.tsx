import { CheckCircle2, LockKeyhole, RefreshCw } from "lucide-react";
import { loadReleaseManifest } from "../../lib/release-manifest";
import { DownloadsClient } from "./DownloadsClient";
import styles from "./downloads.module.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Downloads",
  description: "Download sndbox for Windows or install a Linux runner, with release checksums and verification details.",
  alternates: { canonical: "/downloads" },
};

export default async function Page() {
  const manifest = await loadReleaseManifest();
  const releaseLabel = manifest ? `v${manifest.version.replace(/^v/, "")}` : "Release pending";

  return (
    <main id="content" className={styles.page}>
      <section className={styles.hero} aria-labelledby="downloads-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span aria-hidden="true" /> Downloads</p>
          <h1 id="downloads-title">Run sndbox<br />on your terms.</h1>
          <p className={styles.lede}>
            Build and run workflows on Windows, or keep scheduled work moving
            with a lightweight Linux runner on infrastructure you control.
          </p>
        </div>

        <aside className={styles.releaseCard} aria-label="Current release status">
          <div className={styles.releaseCardTop}>
            <div>
              <span>Current release</span>
              <strong>{releaseLabel}</strong>
            </div>
            <span className={styles.channel}>{manifest?.channel ?? "beta"}</span>
          </div>
          <div className={styles.releaseGrid}>
            <p><CheckCircle2 aria-hidden="true" size={16} /><span><strong>{manifest ? "Manifest published" : "Release pending"}</strong>Versioned release record</span></p>
            <p><LockKeyhole aria-hidden="true" size={16} /><span><strong>Checksums included</strong>SHA-256 for every file</span></p>
            <p><RefreshCw aria-hidden="true" size={16} /><span><strong>Update in place</strong>Your workflows stay local</span></p>
          </div>
        </aside>
      </section>

      <DownloadsClient manifest={manifest} />
    </main>
  );
}
