import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const publicRoute=request.nextUrl.pathname==="/sign-in"||request.nextUrl.pathname.startsWith("/auth/")||request.nextUrl.pathname.startsWith("/r/");
  if(!publicRoute&&!request.cookies.has("sandbox_session")){
    const destination=request.nextUrl.clone();destination.pathname="/sign-in";destination.search=new URLSearchParams({returnTo:`${request.nextUrl.pathname}${request.nextUrl.search}`}).toString();return NextResponse.redirect(destination);
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api|_next|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
