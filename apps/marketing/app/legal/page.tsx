import type { Metadata } from "next";
import Link from "next/link";
import { legalPages } from "@sandbox/content";
import { legalDetailsComplete } from "./legal-config";
import { legalDocuments } from "./legal-content";

export const metadata: Metadata = { title: "Legal documents", description: "sndbox terms, privacy, cookies, refunds, accessibility and marketplace policies." };

export default function Page() {
  return <main id="content" className="legal-page legal-index">
    <p className="eyebrow"><span />Legal</p>
    <h1>Legal documents</h1>
    <p className="legal-summary">Terms and policies for the sndbox website, software, cloud services and plugin marketplace in the United Kingdom and Ireland.</p>
    {!legalDetailsComplete && <aside className="legal-draft"><strong>Substantive drafts — publication details required</strong><p>The policies have been written against the implemented product and applicable UK and Irish law, but highlighted operator details and the final production vendor register must be completed and approved by qualified counsel before launch.</p></aside>}
    <div className="legal-directory">{legalPages.map((slug, index) => { const document = legalDocuments[slug]; return <Link href={`/legal/${slug}`} key={slug}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{document.title}</strong><p>{document.summary}</p></div><b aria-hidden="true">→</b></Link>; })}</div>
  </main>;
}
