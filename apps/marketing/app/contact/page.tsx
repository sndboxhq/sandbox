"use client";

import { useEffect, useState } from "react";

const enquiryTypes = new Set([
  "enterprise",
  "publisher",
  "product",
  "security-documents",
  "legal",
  "privacy",
  "accessibility",
  "security",
]);

export default function Page() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [correlation, setCorrelation] = useState("");
  const [type, setType] = useState("enterprise");

  useEffect(() => {
    const requestedType = new URLSearchParams(window.location.search).get("type");
    if (requestedType && enquiryTypes.has(requestedType)) setType(requestedType);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    setCorrelation("");

    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      const body = (await response.json()) as { correlationId?: string };
      setCorrelation(body.correlationId ?? "");
      setState(response.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <main id="content" className="form-page">
      <header>
        <p className="eyebrow"><span />Contact</p>
        <h1>Talk to the right team.</h1>
        <p>Product, commercial, legal, privacy, accessibility and security enquiries are routed separately.</p>
      </header>
      {state === "sent" ? (
        <section className="form-success" role="status">
          <h2>Enquiry received.</h2>
          <p>Reference {correlation}</p>
        </section>
      ) : (
        <form onSubmit={submit}>
          <label>
            Enquiry type
            <select name="type" required value={type} onChange={(event) => setType(event.target.value)}>
              <option value="enterprise">Enterprise</option>
              <option value="publisher">Publisher</option>
              <option value="product">Product</option>
              <option value="security-documents">Security documentation</option>
              <option value="legal">Legal or consumer complaint</option>
              <option value="privacy">Privacy request</option>
              <option value="accessibility">Accessibility feedback</option>
              <option value="security">Security vulnerability</option>
            </select>
          </label>
          <label>Name<input name="name" required minLength={2} /></label>
          <label>Work email<input name="email" type="email" required /></label>
          <label>Organisation<input name="organisation" /></label>
          <label>What do you need?<textarea name="message" required minLength={20} rows={6} /></label>
          <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
          <label className="consent"><input type="checkbox" name="consent" value="yes" required /> I have read the <a href="/legal/privacy">Privacy notice</a> and understand that sndbox will use these details to respond.</label>
          <button type="submit" disabled={state === "sending"} className="sb-button sb-button--primary">
            {state === "sending" ? "Sending…" : "Send enquiry"}
          </button>
          {state === "error" && <p role="alert">The enquiry could not be routed. Reference {correlation || "unavailable"}.</p>}
        </form>
      )}
    </main>
  );
}
