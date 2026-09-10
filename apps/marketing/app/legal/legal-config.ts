/**
 * Publication gate for the legal pages.
 *
 * Replace every REQUIRED value with the approved corporate details before launch.
 * Keeping these values in one file prevents different policies naming different
 * contracting entities or contact points.
 */
export const legalConfig = {
  tradingName: "sndbox",
  legalName: "[REQUIRED: full legal entity name]",
  companyNumber: "[REQUIRED: company registration number and register]",
  registeredOffice: "[REQUIRED: registered office / geographic address]",
  vatNumber: "[REQUIRED if VAT registered]",
  legalEmail: "legal@sndbox.app",
  privacyEmail: "privacy@sndbox.app",
  accessibilityEmail: "support@sndbox.app",
  securityEmail: "legal@sndbox.app",
  telephone: "[REQUIRED for Irish consumer sales: telephone number]",
  euRepresentative: "Not applicable]",
  ukRepresentative: "Not applicable]",
  dsaLegalRepresentative: "Not applicable]",
  establishment: "United Kingdom",
  effectiveDate: "10 September 2026",
  version: "1.0-draft",
} as const;

export const requiredLegalFields = [
  legalConfig.legalName,
  legalConfig.companyNumber,
  legalConfig.registeredOffice,
  legalConfig.vatNumber,
  legalConfig.legalEmail,
  legalConfig.privacyEmail,
  legalConfig.accessibilityEmail,
  legalConfig.securityEmail,
  legalConfig.telephone,
  legalConfig.euRepresentative,
  legalConfig.ukRepresentative,
  legalConfig.dsaLegalRepresentative,
  legalConfig.establishment,
];

export const legalDetailsComplete = requiredLegalFields.every((value) => !value.startsWith("[REQUIRED"));
