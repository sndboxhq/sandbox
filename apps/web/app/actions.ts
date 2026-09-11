"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticatedClient, sessionCookie } from "../lib/auth";
import { workspaceContextCookie } from "../lib/workspace-context";
import type { PortalActionResult } from "./action-result";

async function client() {
  const value = await authenticatedClient();
  if (!value)
    throw new Error("Your account session has expired. Sign in again.");
  return value;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required.`);
  return value.trim();
}

function actionError(error: unknown, fallback: string): PortalActionResult {
  return { status: "error", message: error instanceof Error ? error.message : fallback };
}

export async function setWorkspaceContextAction(formData: FormData) {
  const api = await client();
  const workspaceId = field(formData, "workspaceId");
  const organisations = (await api.listAccountOrganisations()).data.items;
  if (!organisations.some((organisation) => organisation.workspaces.some((workspace) => workspace.id === workspaceId))) throw new Error("That workspace is no longer available to this account.");
  (await cookies()).set(workspaceContextCookie, workspaceId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  const requested = (formData.get("returnTo") as string | null) ?? "/";
  const safePath = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  const target = new URL(safePath, "https://app.sndbox.app");
  target.searchParams.set("workspaceId", workspaceId);
  redirect(`${target.pathname}${target.search}${target.hash}`);
}

export async function createOrganisationAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    await api.createOrganisation({ name: field(formData, "name"), slug: field(formData, "slug") });
    revalidatePath("/organisations");
    return { status: "success", message: "Organisation created." };
  } catch (error) { return actionError(error, "The organisation could not be created."); }
}

export async function inviteMemberAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    const workspaceId = field(formData, "workspaceId");
    const email = field(formData, "email").toLowerCase();
    const role = field(formData, "role");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: "error", message: "Enter a valid email address.", fieldErrors: { email: "Enter a valid email address." } };
    if (!["administrator", "developer", "operator", "viewer"].includes(role)) return { status: "error", message: "Choose an available workspace role.", fieldErrors: { role: "Choose an available workspace role." } };
    const response = await api.createWorkspaceInvitation(workspaceId, { email, role: role as "administrator" | "developer" | "operator" | "viewer", workspaceIds: [workspaceId], expiresInHours: 72 });
    revalidatePath("/organisations");
    if (response.data.delivery.status === "manual") return { status: "success", message: `Invitation created for ${email}. Copy the secure link below and share it directly.`, copyValue: response.data.delivery.invitationUrl, copyLabel: "Copy invitation link" };
    return { status: "success", message: `Invitation sent to ${email}.` };
  } catch (error) { return actionError(error, "The invitation could not be sent."); }
}

export async function decideApprovalAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    const workspaceId = field(formData, "workspaceId");
    const decision = field(formData, "decision") as "approved" | "rejected";
    const reason = (formData.get("reason") as string | null)?.trim() || null;
    if (decision !== "approved" && decision !== "rejected") return { status: "error", message: "Choose approve or reject." };
    if (decision === "rejected" && !reason) return { status: "error", message: "Add a review note before rejecting.", fieldErrors: { reason: "A rejection reason is required." } };
    await api.decideWorkflowApproval(workspaceId, field(formData, "approvalId"), decision, reason);
    revalidatePath("/organisations");
    return { status: "success", message: decision === "approved" ? "Revision approved." : "Revision rejected." };
  } catch (error) { return actionError(error, "The review decision could not be saved."); }
}

export async function publishWorkflowAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    await api.publishWorkflow(field(formData, "workspaceId"), field(formData, "workflowId"), field(formData, "revisionId"), field(formData, "changeSummary"));
    revalidatePath("/organisations");
    return { status: "success", message: "Approved revision published." };
  } catch (error) { return actionError(error, "The revision could not be published."); }
}

export async function transitionDeploymentAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    const workspaceId = field(formData, "workspaceId");
    const status = field(formData, "status");
    if (status !== "active" && status !== "paused" && status !== "rolled_back") return { status: "error", message: "Unsupported deployment transition." };
    await api.transitionDeployment(workspaceId, field(formData, "deploymentId"), { status, reason: field(formData, "reason") });
    revalidatePath("/organisations");
    return { status: "success", message: status === "paused" ? "Deployment paused." : "Deployment resumed." };
  } catch (error) { return actionError(error, "The deployment state could not be changed."); }
}

export async function revokeSessionAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    await api.revokeAccountSession(field(formData, "sessionId"));
    revalidatePath("/security");
    return { status: "success", message: "Device session revoked." };
  } catch (error) { return actionError(error, "The device session could not be revoked."); }
}

export interface PersonalTokenActionState {
  token: string | null;
  prefix: string | null;
  error: string | null;
}

export async function issuePersonalTokenAction(
  _state: PersonalTokenActionState,
  formData: FormData,
): Promise<PersonalTokenActionState> {
  try {
    const api = await client();
    const [organisationId, workspaceId] = field(formData, "target").split(":");
    if (!organisationId || !workspaceId) throw new Error("Choose a workspace for this key.");
    const scopes = formData
      .getAll("scope")
      .filter((value): value is string => typeof value === "string");
    if (!scopes.length) throw new Error("Choose at least one permission.");
    const response = await api.createPersonalAccessToken({
      name: field(formData, "name"),
      organisationId,
      workspaceIds: [workspaceId],
      scopes,
      expiresInDays: Number(field(formData, "expiresInDays")),
    });
    revalidatePath("/security");
    return {
      token: response.data.credential.token,
      prefix: response.data.credential.prefix,
      error: null,
    };
  } catch (error) {
    return {
      token: null,
      prefix: null,
      error: error instanceof Error ? error.message : "The API key could not be created.",
    };
  }
}

export async function revokePersonalTokenAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    await api.revokePersonalAccessToken(field(formData, "tokenId"), "Revoked from account security settings");
    revalidatePath("/security");
    return { status: "success", message: "API key revoked." };
  } catch (error) { return actionError(error, "The API key could not be revoked."); }
}

export interface AccountMaintenanceState {
  error: string | null;
  message: string | null;
}

export async function revokeOtherSessionsAction(
  _state: AccountMaintenanceState,
  _formData: FormData,
): Promise<AccountMaintenanceState> {
  try {
    const api = await client();
    const sessions = (await api.listAccountSessions()).data.items.filter(
      (session) => !session.current,
    );
    await Promise.all(
      sessions.map((session) => api.revokeAccountSession(session.id)),
    );
    revalidatePath("/security");
    revalidatePath("/settings");
    return {
      error: null,
      message: sessions.length
        ? `${sessions.length} other ${sessions.length === 1 ? "session" : "sessions"} signed out.`
        : "No other signed-in devices were found.",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Other sessions could not be signed out.",
      message: null,
    };
  }
}

export async function revokeAllPersonalTokensAction(
  _state: AccountMaintenanceState,
  _formData: FormData,
): Promise<AccountMaintenanceState> {
  try {
    const api = await client();
    const tokens = (await api.listPersonalAccessTokens()).data.items.filter(
      (token) => !token.revokedAt,
    );
    await Promise.all(
      tokens.map((token) =>
        api.revokePersonalAccessToken(token.id, "Revoked from account danger zone"),
      ),
    );
    revalidatePath("/security");
    revalidatePath("/settings");
    return {
      error: null,
      message: tokens.length
        ? `${tokens.length} API ${tokens.length === 1 ? "key" : "keys"} revoked.`
        : "No active API keys were found.",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "API keys could not be revoked.",
      message: null,
    };
  }
}

export interface RunnerPairingActionState {
  token: string | null;
  prefix: string | null;
  error: string | null;
}

export async function issueRunnerPairingTokenAction(
  _state: RunnerPairingActionState,
  formData: FormData,
): Promise<RunnerPairingActionState> {
  try {
    const api = await client();
    const [organisationId, workspaceId] = field(formData, "target").split(":");
    if (!organisationId || !workspaceId) throw new Error("Choose the workspace this runner will join.");
    const response = await api.createPersonalAccessToken({
      name: `Runner pairing · ${field(formData, "runnerName")}`,
      organisationId,
      workspaceIds: [workspaceId],
      scopes: ["runners.manage"],
      expiresInDays: 1,
    });
    revalidatePath("/operations");
    return { token: response.data.credential.token, prefix: response.data.credential.prefix, error: null };
  } catch (error) {
    return { token: null, prefix: null, error: error instanceof Error ? error.message : "The pairing token could not be created." };
  }
}

export async function updateRunnerStatusAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    const workspaceId = field(formData, "workspaceId");
    const status = field(formData, "status");
    await api.request({ method: "PATCH", path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runners/${encodeURIComponent(field(formData, "runnerId"))}`, body: { displayName: null, status } });
    revalidatePath("/operations");
    return { status: "success", message: status === "draining" ? "Runner is draining." : "Runner resumed." };
  } catch (error) { return actionError(error, "The runner state could not be changed."); }
}

export async function revokeRunnerAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    const workspaceId = field(formData, "workspaceId");
    await api.request({ method: "DELETE", path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runners/${encodeURIComponent(field(formData, "runnerId"))}`, body: {} });
    revalidatePath("/operations");
    return { status: "success", message: "Runner access revoked." };
  } catch (error) { return actionError(error, "Runner access could not be revoked."); }
}

export interface AccountDeletionState {
  error: string | null;
}

export async function deleteAccountAction(
  _state: AccountDeletionState,
  formData: FormData,
): Promise<AccountDeletionState> {
  try {
    if (field(formData, "confirmation") !== "DELETE") {
      return { error: "Type DELETE exactly to confirm." };
    }
    const api = await client();
    await api.request({ method: "DELETE", path: "/v1/account", body: {} });
    (await cookies()).delete(sessionCookie);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Account deletion could not be completed.",
    };
  }
  redirect("/sign-in");
}

export async function createRoleAction(formData: FormData) {
  const api = await client();
  await api.createOrganisationRole(field(formData, "organisationId"), {
    key: field(formData, "key"),
    displayName: field(formData, "displayName"),
    permissions: formData
      .getAll("permission")
      .filter((value): value is string => typeof value === "string"),
  });
  revalidatePath("/organisations");
}

export async function createSsoConnectionAction(formData: FormData) {
  const api = await client();
  await api.createSsoConnection(field(formData, "organisationId"), {
    connectionType: field(formData, "connectionType") as "oidc" | "saml",
    displayName: field(formData, "displayName"),
    issuerUrl: field(formData, "issuerUrl"),
    clientIdentifier: field(formData, "clientIdentifier"),
    verifiedDomains: field(formData, "verifiedDomains")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    enabled: false,
  });
  revalidatePath("/organisations");
}

export interface ScimTokenActionState {
  token: string | null;
  prefix: string | null;
  error: string | null;
}

export async function issueScimTokenAction(
  _state: ScimTokenActionState,
  formData: FormData,
): Promise<ScimTokenActionState> {
  try {
    const api = await client();
    const response = await api.createScimToken(
      field(formData, "organisationId"),
      {
        name: field(formData, "name"),
        expiresInDays: Number(field(formData, "expiresInDays")),
      },
    );
    revalidatePath("/organisations");
    return {
      token: response.data.credential.token,
      prefix: response.data.credential.prefix,
      error: null,
    };
  } catch (error) {
    return {
      token: null,
      prefix: null,
      error:
        error instanceof Error
          ? error.message
          : "SCIM credential creation failed.",
    };
  }
}

export async function revokeScimTokenAction(_state: PortalActionResult, formData: FormData): Promise<PortalActionResult> {
  try {
    const api = await client();
    await api.revokeScimToken(field(formData, "organisationId"), field(formData, "tokenId"));
    revalidatePath("/organisations");
    return { status: "success", message: "SCIM credential revoked." };
  } catch (error) { return actionError(error, "The SCIM credential could not be revoked."); }
}
