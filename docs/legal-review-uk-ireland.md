# UK and Ireland legal-content review

Status: substantive draft completed 10 September 2026. Not approved for publication.

This review maps the public legal pages to the implemented product and primary/official legal sources. It is a launch-control document, not legal advice. Qualified UK and Irish counsel must confirm the operator, establishment, customer model and live deployment before removing the in-product draft warning.

## Pages delivered

| Route | Main scope |
| --- | --- |
| `/legal/terms` | Account, desktop, hosted execution, subscriptions, credit, licences, liability and consumer savings |
| `/legal/privacy` | Controller/processor split, Article 13/14 information, sources, purposes, legal bases, recipients, transfers, retention and rights |
| `/legal/cookies` | Exact application cookies, duration, legal basis and desktop/browser-profile distinction |
| `/legal/acceptable-use` | Workflow, runner, automation, content and high-impact-use restrictions |
| `/legal/refunds` | UK/Ireland 14-day cancellation, immediate performance, digital content, subscriptions, credit, plugins and model form |
| `/legal/accessibility` | WCAG 2.2 AA target, implemented features, known limitations, feedback and UK/Irish duties |
| `/legal/complaints` | Service, consumer, privacy, accessibility, DSA notices, IP notices and appeals |
| `/legal/marketplace-terms` | Platform role, trader identity, ranking, review, moderation, DSA and Online Safety Act position |
| `/legal/publisher-terms` | Submission warranties, licences, support, moderation, commercial terms and trader duties |
| `/legal/data-processing-addendum` | Article 28 terms, security, subprocessors, assistance, breach, deletion, audits and transfers |
| `/legal/subprocessors` | Production provider register and change-objection process |
| `/legal/vulnerability-disclosure` | Reporting, safe-harbour boundaries, permitted and prohibited testing |

## Official sources checked

| Area | United Kingdom | Ireland / EU |
| --- | --- | --- |
| Data protection | [UK GDPR guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/), [Data Protection Act 2018](https://www.legislation.gov.uk/ukpga/2018/12/contents), [Data (Use and Access) Act 2025](https://www.legislation.gov.uk/ukpga/2025/18/contents) | [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj), [Data Protection Act 2018](https://www.irishstatutebook.ie/eli/2018/act/7/enacted/en/html), [DPC transparency guidance](https://www.dataprotection.ie/en/organisations/know-your-obligations/transparency) |
| Cookies/direct marketing | [Privacy and Electronic Communications Regulations 2003](https://www.legislation.gov.uk/uksi/2003/2426/contents), [ICO cookie guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/) | [S.I. 336/2011](https://www.irishstatutebook.ie/eli/2011/si/336/made/en/print), [DPC cookie guidance](https://www.dataprotection.ie/en/dpc-guidance/guidance-cookies-and-other-tracking-technologies) |
| Consumer contracts | [Consumer Rights Act 2015](https://www.legislation.gov.uk/ukpga/2015/15/contents), [Consumer Contracts Regulations 2013](https://www.legislation.gov.uk/uksi/2013/3134/contents), [official distance-selling guidance](https://www.gov.uk/online-and-distance-selling-for-businesses/distance-selling) | [Consumer Rights Act 2022](https://www.irishstatutebook.ie/eli/2022/act/37/enacted/en/html), [CCPC digital-content/service guidance](https://www.ccpc.ie/information-for-businesses/selling-goods-and-services/selling-digital-content-or-services) |
| International transfers | [ICO IDTA and Addendum guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/appropriate-safeguards/what-are-standard-data-protection-clauses-the-uk-idta-and-the-addendum/) | [EU SCC Decision 2021/914](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:32021D0914), [DPC transfer guidance](https://www.dataprotection.ie/en/organisations/international-transfers/transfers-personal-data-third-countries-or-international-organisations) |
| Accessibility | [Equality Act 2010](https://www.legislation.gov.uk/ukpga/2010/15/contents), [Disability Discrimination Act 1995](https://www.legislation.gov.uk/ukpga/1995/50/contents) | [S.I. 636/2023](https://www.irishstatutebook.ie/eli/2023/si/636/made/en/print), applying from 28 June 2025 |
| Online platforms | [Online Safety Act 2023](https://www.legislation.gov.uk/ukpga/2023/50/contents), [Ofcom duties guidance](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/illegal-content-duties-under-the-online-safety-act) | [Digital Services Act](https://eur-lex.europa.eu/eli/reg/2022/2065/oj), [Coimisiún na Meán platform obligations](https://www.cnam.ie/industry-and-professionals/online-safety-framework/digital-services-act/what-are-the-obligations-for-service-providers/) |
| Trading identity | [Electronic Commerce Regulations 2002](https://www.legislation.gov.uk/uksi/2002/2013/contents), [Companies (Trading Disclosures) Regulations 2008](https://www.legislation.gov.uk/uksi/2008/495/contents) | [Consumer Rights Act 2022, distance-contract information](https://www.irishstatutebook.ie/eli/2022/act/37/section/106/enacted/en/html) |

## Product facts reconciled

- Marketing ships no third-party advertising or analytics script. Optional OpenTelemetry export is server-side and deployment-configurable.
- Account authentication uses OIDC authorization code with PKCE. Temporary sign-in cookies last 10 minutes; the HTTP-only session cookie lasts no more than 8 hours.
- A referral cookie lasts 30 days. Referral attribution is not clearly necessary for the user-requested service, so UK/Irish consent should be obtained before it is set. The current route sets it immediately and is a launch blocker.
- Stripe is the implemented billing provider; card details do not pass through sndbox servers. The production Stripe entity, data role and processing locations must come from the signed account agreement.
- Hosted workflow and execution data can contain customer-selected personal data. The terms and privacy notice therefore distinguish sndbox's controller activities from its processor role under the DPA.
- Default configurable retention is taken from `docs/privacy-and-retention-v0.5.md`: execution detail 90 days, terminal queue history 30 days, webhook deliveries 7 days, runner commands 30 days and workspace audit history 2,555 days.
- Local workflows and credentials remain local by default. Hosted sync, execution, managed browser profiles and selected integrations create separate data flows.
- Support access is customer-approved, time-bounded, diagnostics-only and audited; it does not grant shell, database, secrets, workflow payload or browser-profile access.
- Marketplace packages are immutable, signed, capability-declared and subject to automated checks plus a human decision. Verified publisher status is not described as an endorsement.
- The UK data-protection complaint duties inserted by section 103 of the Data (Use and Access) Act 2025 have applied since 19 June 2026. The privacy and complaints pages provide an electronic route, a service target faster than the statutory 30-day acknowledgement limit, appropriate investigation, progress updates and an outcome notice.
- The UK subscription-contract regime is announced to start in January 2027. The legal text preserves current Consumer Contracts Regulations rights and the launch checklist requires easy online exit, reminder notices and renewal cooling-off support before affected sales.

## Mandatory pre-publication decisions

1. Fill every field in `apps/marketing/app/legal/legal-config.ts`: legal name, register/number, geographic and registered address, VAT status, telephone, monitored legal/privacy/accessibility/security contacts, establishment, and any Article 27 or DSA representative.
2. Decide which entity contracts with UK customers and which contracts with Irish/EEA customers. Re-check governing law, VAT, regulatory contacts and cross-border transfer language against that structure.
3. Inventory all live infrastructure, identity, storage, email, observability, support, AI and scanning vendors. Execute DPAs, classify controller/processor roles, record locations and transfer mechanisms, and replace every placeholder in the subprocessor register.
4. Implement prior consent for `sandbox_referral`, or remove it for UK/Irish visitors. Add a consent log and equally easy withdrawal if any non-essential storage, analytics or advertising is introduced.
5. Add checkout evidence that saves the contract on a durable medium and captures any express request to start services during the cancellation period. Separately capture express consent and acknowledgement before relying on the digital-content cancellation exception.
6. Implement an online subscription cancellation control, renewal reminders and the renewal cooling-off workflow needed for the UK subscription-contract regime announced to take effect in January 2027. Confirm the actual refund operations, credit treatment, currency, VAT-inclusive display and payment-provider timelines against the policy.
7. Complete an Online Safety Act service assessment, illegal-content risk assessment and children's access assessment for the marketplace. Complete the DSA applicability, establishment/representative, trader-traceability, statement-of-reasons, appeal, transparency-reporting and monthly-active-recipient work.
8. Determine whether the Irish accessibility regulations cover the service and whether a microenterprise exemption applies. If covered, prepare the Schedule 3 service information. Complete automated, keyboard, zoom, contrast and external screen-reader testing against WCAG 2.2 AA.
9. Set documented retention periods for enquiries, support cases, marketplace verification, incidents, security logs, backups and tax records; align storage lifecycle rules with them.
10. Obtain UK and Irish counsel approval and operational owner sign-off. Archive the approved text and evidence for the displayed version/effective date.

## Items intentionally not asserted

- No claim of complete legal compliance, certification, uptime, insurance, external accessibility conformance or independent security assurance.
- No claim that EU SCCs or the UK Addendum are effective without completed modules, tables and annexes.
- No invented legal entity, address, company/VAT number, representative, vendor, processing location, retention period or support email.
- No blanket “no refunds” rule and no automatic loss of cancellation rights merely because software was downloaded.
- No claim that an age limit alone removes Online Safety Act child-safety assessment duties.
