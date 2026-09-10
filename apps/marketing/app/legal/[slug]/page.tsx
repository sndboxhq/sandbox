import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { legalPages } from "@sandbox/content";
import { legalDetailsComplete } from "../legal-config";
import { legalDocuments, type LegalSlug } from "../legal-content";

type Params = Promise<{ slug: string }>;

export function generateStaticParams() {
  return legalPages.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const document = legalDocuments[slug as LegalSlug];
  return document ? { title: document.title, description: document.summary } : {};
}

export default async function Page({ params }: { params: Params }) {
  const { slug } = await params;
  if (!legalPages.includes(slug as never)) notFound();
  const document = legalDocuments[slug as LegalSlug];
  if (!document) notFound();

  return (
    <main id="content" className="legal-page legal-document">
      <nav className="legal-breadcrumb" aria-label="Breadcrumb">
        <Link href="/legal">Legal documents</Link><span aria-hidden="true">/</span><span>{document.shortTitle}</span>
      </nav>
      <header>
        <p className="eyebrow"><span />Legal</p>
        <h1>{document.title}</h1>
        <p className="legal-summary">{document.summary}</p>
        <dl className="legal-meta"><div><dt>Applies to</dt><dd>{document.audience}</dd></div><div><dt>Effective</dt><dd>10 September 2026</dd></div><div><dt>Version</dt><dd>1.0-draft</dd></div></dl>
      </header>

      {!legalDetailsComplete && <aside className="legal-draft" role="note"><strong>Publication details incomplete</strong><p>This is a substantive legal draft, not an approved final policy. The repository does not identify the contracting legal entity, registration, address or monitored legal contacts. Every highlighted field must be completed and counsel must confirm the live vendors, checkout consent flow, service locations and corporate jurisdiction before publication.</p></aside>}

      <div className="legal-layout">
        <nav className="legal-toc" aria-label={`Contents of ${document.title}`}>
          <strong>On this page</strong>
          {document.sections.map((section) => <a href={`#${section.id}`} key={section.id}>{section.title.replace(/^\d+\.\s*/, "")}</a>)}
        </nav>
        <article className="legal-copy">
          {document.sections.map((section) => <section id={section.id} key={section.id}><h2>{section.title}</h2>{section.content}</section>)}
        </article>
      </div>
      <nav className="legal-related" aria-label="Other legal documents">
        <strong>Other documents</strong>
        <div>{legalPages.filter((item) => item !== slug).map((item) => <Link href={`/legal/${item}`} key={item}>{legalDocuments[item].shortTitle}</Link>)}</div>
      </nav>
    </main>
  );
}
