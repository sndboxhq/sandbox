import type { MetadataRoute } from "next";
import { brand } from "@sandbox/brand";
import { legalPages, productPages, useCases } from "@sandbox/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = brand.domains.marketing;
  const lastModified = new Date();
  const staticRoutes = [
    "",
    "/solutions",
    "/integrations",
    "/marketplace",
    "/pricing",
    "/downloads",
    "/news",
    "/changelog",
    "/security",
    "/enterprise",
    "/support",
    "/contact",
    "/legal",
  ];

  return [
    ...staticRoutes.map((path) => ({ url: `${base}${path}`, lastModified })),
    ...productPages.map((page) => ({
      url: `${base}${page.slug === "developers" ? "/developers" : `/product/${page.slug}`}`,
      lastModified,
    })),
    ...useCases.flatMap((page) => [
      { url: `${base}/solutions/${page.slug}`, lastModified },
      { url: `${base}/templates/${page.slug}`, lastModified },
    ]),
    ...legalPages.map((page) => ({ url: `${base}/legal/${page}`, lastModified })),
  ];
}
