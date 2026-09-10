import { NextResponse } from "next/server";
import { authenticatedClient } from "../../../../../lib/auth";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  if (!uuid.test(workspaceId)) return NextResponse.json({ error: "Invalid workspace." }, { status: 400 });
  const api = await authenticatedClient();
  if (!api) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const result = await api.getWorkspaceActivity(workspaceId);
    return NextResponse.json(result.data, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Workspace activity is temporarily unavailable." }, { status: 502 });
  }
}
