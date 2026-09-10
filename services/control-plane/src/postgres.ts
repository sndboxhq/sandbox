import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import type { AuditEvent, BuiltInRole, DeploymentRecord, MarketplaceListing, Permission, RunnerCommand, RunnerRecord, RunSummary, WorkflowRevision, WorkspaceActivitySummary } from "@sandbox/contracts";
import { permissions as allPermissions, rolePermissionMatrix } from "@sandbox/contracts";
import { Pool, type PoolClient } from "pg";
import { satisfies } from "semver";
import type { AccountOrganisationRecord, AuthenticatedSession, ControlPlaneRepository, DeploymentCreationInput, InvitationInput, InvitationRecord, MarketplacePackage, MarketplaceQuery, OrganisationInput, OrganisationRoleRecord, PluginSubmissionInput, PluginSubmissionRecord, PublisherInput, RunnerCommandInput, RunnerDeviceRequestInput, RunnerDeviceSession, RunnerPairingChallengeInput, RunnerPairingConfirmationInput, RunnerPoolInput, RunnerPoolRecord, RunnerTriggerEventInput, ScimManagedUserInput, ScimManagedUserRecord, ScimTokenSummary, SharedConnectionRecord, SsoConnectionInput, SsoConnectionRecord, SyncedWorkflowInput, SyncedWorkflowRecord, SyncWriteResult, WebhookEndpointRecord, WorkflowApprovalRecord } from "./types.js";
import { DomainError } from "./types.js";
import { verifyRunnerRequestSignature } from "./runner_protocol.js";
import type { BillingEvent } from "./billing.js";
import { requireDeploymentTransition } from "./deployment.js";

export class PostgresRepository implements ControlPlaneRepository {
  constructor(private readonly pool: Pool) {}

  async permissions(accountId: string, workspaceId: string): Promise<ReadonlySet<Permission>> {
    return this.withAccount(accountId, async client => {
      const result = await client.query<{ permission: Permission }>(
        `SELECT rp.permission
           FROM workspace_memberships wm
           JOIN role_permissions rp ON rp.role_id = wm.role_id
          WHERE wm.workspace_id = $1 AND wm.account_id = $2`,
        [workspaceId, accountId]
      );
      return new Set(result.rows.map(row => row.permission).filter(permission => allPermissions.includes(permission)));
    });
  }

  async listAccountOrganisations(actor: AuthenticatedSession): Promise<AccountOrganisationRecord[]> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{
        organisation_id:string; organisation_name:string; organisation_slug:string; organisation_created_at:Date; organisation_role:BuiltInRole;
        workspace_id:string | null; workspace_name:string | null; workspace_slug:string | null; workspace_created_at:Date | null; workspace_role:BuiltInRole | null;
      }>(
        `SELECT organisation.id AS organisation_id, organisation.name AS organisation_name,
                organisation.slug AS organisation_slug, organisation.created_at AS organisation_created_at,
                organisation_role.role_key AS organisation_role,
                workspace.id AS workspace_id, workspace.name AS workspace_name,
                workspace.slug AS workspace_slug, workspace.created_at AS workspace_created_at,
                workspace_role.role_key AS workspace_role
           FROM memberships membership
           JOIN organisations organisation ON organisation.id = membership.organisation_id AND organisation.deleted_at IS NULL
           JOIN roles organisation_role ON organisation_role.id = membership.role_id
           LEFT JOIN workspace_memberships workspace_membership ON workspace_membership.account_id = membership.account_id
           LEFT JOIN workspaces workspace ON workspace.id = workspace_membership.workspace_id
             AND workspace.organisation_id = organisation.id AND workspace.deleted_at IS NULL
           LEFT JOIN roles workspace_role ON workspace_role.id = workspace_membership.role_id
          WHERE membership.account_id = $1 AND membership.status = 'active'
          ORDER BY organisation.name, workspace.name`,
        [actor.accountId]
      );
      const organisations = new Map<string, AccountOrganisationRecord>();
      for (const row of result.rows) {
        let organisation = organisations.get(row.organisation_id);
        if (!organisation) {
          organisation = {
            id: row.organisation_id,
            name: row.organisation_name,
            slug: row.organisation_slug,
            role: row.organisation_role,
            createdAt: row.organisation_created_at.toISOString(),
            workspaces: []
          };
          organisations.set(row.organisation_id, organisation);
        }
        if (row.workspace_id && row.workspace_name && row.workspace_slug && row.workspace_created_at && row.workspace_role) {
          organisation.workspaces.push({
            id: row.workspace_id,
            organisationId: row.organisation_id,
            name: row.workspace_name,
            slug: row.workspace_slug,
            role: row.workspace_role,
            createdAt: row.workspace_created_at.toISOString()
          });
        }
      }
      return [...organisations.values()];
    });
  }

  async createOrganisation(actor: AuthenticatedSession, input: OrganisationInput, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const organisation = await client.query<{ id: string; name: string; slug: string; created_at: Date }>(
        `INSERT INTO organisations(name, slug, created_by) VALUES($1, $2, $3) RETURNING id, name, slug, created_at`,
        [input.name, input.slug, actor.accountId]
      );
      const organisationId = organisation.rows[0].id;
      const workspace = await client.query<{ id: string; name: string; slug: string; created_at: Date }>(
        `INSERT INTO workspaces(organisation_id, name, slug, created_by) VALUES($1, $2, 'default', $3) RETURNING id, name, slug, created_at`,
        [organisationId, `${input.name} workspace`, actor.accountId]
      );
      const roleIds = new Map<BuiltInRole, string>();
      for (const role of Object.keys(rolePermissionMatrix) as BuiltInRole[]) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO roles(organisation_id, role_key, display_name, built_in) VALUES($1, $2, $3, true) RETURNING id`,
          [organisationId, role, role[0].toUpperCase() + role.slice(1)]
        );
        roleIds.set(role, inserted.rows[0].id);
        for (const permission of rolePermissionMatrix[role]) {
          await client.query(`INSERT INTO role_permissions(role_id, permission) VALUES($1, $2)`, [inserted.rows[0].id, permission]);
        }
      }
      const ownerRole = roleIds.get("owner")!;
      await client.query(`INSERT INTO memberships(organisation_id, account_id, role_id) VALUES($1, $2, $3)`, [organisationId, actor.accountId, ownerRole]);
      await client.query(`INSERT INTO workspace_memberships(workspace_id, account_id, role_id) VALUES($1, $2, $3)`, [workspace.rows[0].id, actor.accountId, ownerRole]);
      await client.query(`INSERT INTO environments(workspace_id, environment_key) VALUES($1, 'development'), ($1, 'staging'), ($1, 'production')`, [workspace.rows[0].id]);
      await appendAudit(client, actor, workspace.rows[0].id, "organisation.created", "organisation", organisationId, null, { name: input.name, slug: input.slug }, correlationId);
      return {
        organisation: { id: organisationId, name: input.name, slug: input.slug, createdAt: organisation.rows[0].created_at.toISOString() },
        workspace: { id: workspace.rows[0].id, organisationId, name: workspace.rows[0].name, slug: workspace.rows[0].slug, createdAt: workspace.rows[0].created_at.toISOString() }
      };
    });
  }

  async createInvitation(actor: AuthenticatedSession, workspaceId: string, input: InvitationInput, correlationId: string): Promise<InvitationRecord> {
    return this.withAccount(actor.accountId, async client => {
      const workspace = await client.query<{ organisation_id: string }>(`SELECT organisation_id FROM workspaces WHERE id = $1`, [workspaceId]);
      if (!workspace.rowCount) throw new DomainError("workspace_not_found", "Workspace not found or not accessible.", 404);
      const role = await client.query<{ id: string }>(`SELECT id FROM roles WHERE organisation_id = $1 AND role_key = $2 AND built_in`, [workspace.rows[0].organisation_id, input.role]);
      if (!role.rowCount) throw new DomainError("role_not_found", "Invitation role is unavailable.", 400);
      const invitation = await client.query<{ id: string }>(
        `INSERT INTO invitations(organisation_id, email, role_id, token_hash, invited_by, expires_at)
         VALUES($1, lower($2), $3, $4, $5, $6) RETURNING id`,
        [workspace.rows[0].organisation_id, input.email, role.rows[0].id, input.tokenHash, actor.accountId, input.expiresAt]
      );
      for (const selectedWorkspaceId of input.workspaceIds) {
        const selected = await client.query(`SELECT 1 FROM workspaces WHERE id = $1 AND organisation_id = $2`, [selectedWorkspaceId, workspace.rows[0].organisation_id]);
        if (!selected.rowCount) throw new DomainError("invalid_invitation_workspace", "Every invited workspace must belong to the same organisation.", 400);
        await client.query(`INSERT INTO invitation_workspaces(invitation_id, workspace_id) VALUES($1, $2)`, [invitation.rows[0].id, selectedWorkspaceId]);
      }
      await appendAudit(client, actor, workspaceId, "member.invited", "invitation", invitation.rows[0].id, null, { email: input.email, role: input.role, workspaceIds: input.workspaceIds }, correlationId);
      return { id: invitation.rows[0].id, organisationId: workspace.rows[0].organisation_id, workspaceIds: input.workspaceIds, email: input.email.toLowerCase(), role: input.role, expiresAt: input.expiresAt.toISOString(), status: "pending" };
    });
  }

  async acceptInvitation(actor: AuthenticatedSession, rawToken: string, correlationId: string) {
    const tokenHash = createHash("sha256").update(rawToken, "utf8").digest();
    return this.withAccount(actor.accountId, async client => {
      const invitation = await client.query<{ id: string; organisation_id: string; role_id: string; email: string }>(
        `SELECT id, organisation_id, role_id, email FROM invitations
          WHERE token_hash = $1 AND status = 'pending' AND expires_at > now() FOR UPDATE`,
        [tokenHash]
      );
      if (!invitation.rowCount) throw new DomainError("invitation_invalid", "Invitation is invalid, expired, revoked, or already accepted.", 404);
      if (invitation.rows[0].email.toLowerCase() !== actor.email.toLowerCase()) throw new DomainError("invitation_email_mismatch", "Sign in with the email address that was invited.", 403);
      const workspaces = await client.query<{ workspace_id: string }>(`SELECT workspace_id FROM invitation_workspaces WHERE invitation_id = $1`, [invitation.rows[0].id]);
      await client.query(
        `INSERT INTO memberships(organisation_id, account_id, role_id) VALUES($1, $2, $3)
         ON CONFLICT(organisation_id, account_id) DO UPDATE SET role_id = excluded.role_id, status = 'active', removed_at = NULL`,
        [invitation.rows[0].organisation_id, actor.accountId, invitation.rows[0].role_id]
      );
      for (const row of workspaces.rows) {
        await client.query(
          `INSERT INTO workspace_memberships(workspace_id, account_id, role_id) VALUES($1, $2, $3)
           ON CONFLICT(workspace_id, account_id) DO UPDATE SET role_id = excluded.role_id`,
          [row.workspace_id, actor.accountId, invitation.rows[0].role_id]
        );
      }
      await client.query(`UPDATE invitations SET status = 'accepted', accepted_by = $1, accepted_at = now() WHERE id = $2`, [actor.accountId, invitation.rows[0].id]);
      const firstWorkspace = workspaces.rows[0]?.workspace_id;
      if (firstWorkspace) await appendAudit(client, actor, firstWorkspace, "member.invitation_accepted", "invitation", invitation.rows[0].id, null, { accountId: actor.accountId }, correlationId);
      return { organisationId: invitation.rows[0].organisation_id, workspaceIds: workspaces.rows.map(row => row.workspace_id) };
    });
  }

  async createSyncedWorkflow(actor: AuthenticatedSession, workspaceId: string, input: SyncedWorkflowInput, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const inserted = await client.query(
        `INSERT INTO synced_workflows(id, owner_type, owner_id, workspace_id, name)
         VALUES($1, 'workspace', $2, $2, $3)
         ON CONFLICT(id) DO NOTHING`,
        [input.workflowId, workspaceId, input.name]
      );
      const existing = await client.query<{workspace_id:string;name:string}>(
        `SELECT workspace_id, name FROM synced_workflows WHERE id = $1 AND deleted_at IS NULL`,
        [input.workflowId]
      );
      if (!existing.rowCount || existing.rows[0].workspace_id !== workspaceId) throw new DomainError("workflow_id_unavailable", "Workflow ID is already owned by another workspace.", 409);
      if (inserted.rowCount) await appendAudit(client, actor, workspaceId, "workflow.sync_enabled", "workflow", input.workflowId, null, { name: input.name }, correlationId);
      return { workflowId: input.workflowId, name: input.name, ownerType: "workspace" as const, ownerId: workspaceId };
    });
  }

  async listSyncedWorkflows(actor: AuthenticatedSession, workspaceId: string): Promise<SyncedWorkflowRecord[]> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{
        id:string; name:string; current_draft_revision_id:string | null; current_published_revision_id:string | null; created_at:Date; updated_at:Date | null;
      }>(
        `SELECT workflow.id, workflow.name, workflow.current_draft_revision_id,
                workflow.current_published_revision_id, workflow.created_at,
                revision.updated_at
           FROM synced_workflows workflow
           LEFT JOIN workflow_revisions revision ON revision.id = workflow.current_draft_revision_id
          WHERE workflow.workspace_id = $1 AND workflow.deleted_at IS NULL
          ORDER BY COALESCE(revision.updated_at, workflow.created_at) DESC, workflow.id`,
        [workspaceId]
      );
      return result.rows.map(row => ({
        workflowId: row.id,
        name: row.name,
        currentDraftRevisionId: row.current_draft_revision_id,
        currentPublishedRevisionId: row.current_published_revision_id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at?.toISOString() ?? null
      }));
    });
  }

  async appendWorkflowRevision(actor: AuthenticatedSession, workspaceId: string, revision: WorkflowRevision, correlationId: string): Promise<SyncWriteResult> {
    return this.withAccount(actor.accountId, async client => {
      const workflow = await client.query<{ current_draft_revision_id: string | null }>(`SELECT current_draft_revision_id FROM synced_workflows WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [revision.workflowId, workspaceId]);
      if (!workflow.rowCount) throw new DomainError("workflow_not_found", "Workflow not found or not owned by this workspace.", 404);
      const current = workflow.rows[0].current_draft_revision_id;
      const conflictRevisionId = detectSyncConflict(current, revision.parentRevisionId);
      if (revision.parentRevisionId) {
        const parent = await client.query(`SELECT 1 FROM workflow_revisions WHERE id = $1 AND workflow_id = $2`, [revision.parentRevisionId, revision.workflowId]);
        if (!parent.rowCount) throw new DomainError("sync_parent_not_found", "The parent revision does not belong to this workflow. Refresh revision history and retry.", 409);
      }
      const existing = await client.query<{ content_hash: string }>(`SELECT content_hash FROM workflow_revisions WHERE id = $1`, [revision.revisionId]);
      if (existing.rowCount) {
        if (existing.rows[0].content_hash !== revision.contentHash) throw new DomainError("sync_revision_id_reused", "A revision ID cannot be reused for different content.", 409);
        return { revision: { ...revision, syncState: conflictRevisionId ? "conflicted" : "synced" }, conflictRevisionId };
      }
      await client.query(
        `INSERT INTO workflow_revisions(id, workflow_id, parent_revision_id, schema_version, content_hash, encrypted_payload, payload_key_envelope, searchable_metadata, plugin_requirements, permission_requirements, runner_policy, editor_device_id, updated_by, updated_at, publish_status, encryption_algorithm, encryption_key_version, sync_state)
         VALUES($1,$2,$3,$4,$5,decode($6,'base64'),decode($7,'base64'),$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16,$17)`,
        [revision.revisionId, revision.workflowId, revision.parentRevisionId, revision.schemaVersion, revision.contentHash, revision.encryptedPayload, revision.payloadKeyEnvelope, { name: revision.searchableMetadata.name, folderId: revision.searchableMetadata.folderId }, revision.searchableMetadata.requiredPlugins, revision.searchableMetadata.permissionRequirements, revision.searchableMetadata.runnerPolicy, revision.editorDeviceId, actor.accountId, revision.updatedAt, revision.encryption.algorithm, revision.encryption.keyVersion, conflictRevisionId ? "conflicted" : "synced"]
      );
      if (!conflictRevisionId) await client.query(`UPDATE synced_workflows SET current_draft_revision_id = $1 WHERE id = $2`, [revision.revisionId, revision.workflowId]);
      await appendAudit(client, actor, workspaceId, conflictRevisionId ? "workflow.sync_conflict" : "workflow.revision_saved", "workflow_revision", revision.revisionId, null, { workflowId: revision.workflowId, parentRevisionId: revision.parentRevisionId, conflictRevisionId }, correlationId);
      return { revision: { ...revision, syncState: conflictRevisionId ? "conflicted" : "synced" }, conflictRevisionId };
    });
  }

  async listWorkflowRevisions(actor: AuthenticatedSession, workspaceId: string, workflowId: string, cursor: string | null, limit: number) {
    return this.withAccount(actor.accountId, async client => {
      const values: unknown[] = [workflowId, workspaceId, limit + 1];
      const cursorClause = cursor ? "AND (r.updated_at, r.id) < (SELECT updated_at, id FROM workflow_revisions WHERE id = $4 AND workflow_id = $1)" : "";
      if (cursor) values.push(cursor);
      const result = await client.query<WorkflowRevisionRow>(
        `SELECT r.id, r.workflow_id, r.parent_revision_id, r.schema_version, r.content_hash,
                encode(r.encrypted_payload,'base64') AS encrypted_payload,
                encode(r.payload_key_envelope,'base64') AS payload_key_envelope,
                r.searchable_metadata, r.plugin_requirements, r.permission_requirements, r.runner_policy,
                r.editor_device_id, r.updated_at, r.encryption_algorithm, r.encryption_key_version, r.sync_state
           FROM workflow_revisions r
           JOIN synced_workflows w ON w.id = r.workflow_id
          WHERE r.workflow_id = $1 AND w.workspace_id = $2 ${cursorClause}
          ORDER BY r.updated_at DESC, r.id DESC LIMIT $3`,
        values
      );
      const page = result.rows.slice(0, limit);
      return { items: page.map(workflowRevisionFromRow), nextCursor: result.rows.length > limit ? page.at(-1)!.id : null };
    });
  }

  async getWorkflowRevision(actor: AuthenticatedSession, workspaceId: string, workflowId: string, revisionId: string) {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<WorkflowRevisionRow>(
        `SELECT r.id, r.workflow_id, r.parent_revision_id, r.schema_version, r.content_hash,
                encode(r.encrypted_payload,'base64') AS encrypted_payload,
                encode(r.payload_key_envelope,'base64') AS payload_key_envelope,
                r.searchable_metadata, r.plugin_requirements, r.permission_requirements, r.runner_policy,
                r.editor_device_id, r.updated_at, r.encryption_algorithm, r.encryption_key_version, r.sync_state
           FROM workflow_revisions r JOIN synced_workflows w ON w.id = r.workflow_id
          WHERE r.id = $1 AND r.workflow_id = $2 AND w.workspace_id = $3`,
        [revisionId, workflowId, workspaceId]
      );
      return result.rowCount ? workflowRevisionFromRow(result.rows[0]) : null;
    });
  }

  async resolveSyncConflict(actor: AuthenticatedSession, workspaceId: string, workflowId: string, revisionId: string, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const workflow = await client.query<{ current_draft_revision_id: string | null }>(`SELECT current_draft_revision_id FROM synced_workflows WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [workflowId, workspaceId]);
      if (!workflow.rowCount) throw new DomainError("workflow_not_found", "Workflow not found or not owned by this workspace.", 404);
      const selected = await client.query(`SELECT 1 FROM workflow_revisions WHERE id = $1 AND workflow_id = $2`, [revisionId, workflowId]);
      if (!selected.rowCount) throw new DomainError("revision_not_found", "The selected revision does not belong to this workflow.", 404);
      await client.query(`UPDATE synced_workflows SET current_draft_revision_id = $1 WHERE id = $2`, [revisionId, workflowId]);
      await client.query(`UPDATE workflow_revisions SET sync_state = CASE WHEN id = $1 THEN 'synced' ELSE sync_state END WHERE workflow_id = $2`, [revisionId, workflowId]);
      await appendAudit(client, actor, workspaceId, "workflow.sync_conflict_resolved", "workflow_revision", revisionId, { previousDraftRevisionId: workflow.rows[0].current_draft_revision_id }, { selectedRevisionId: revisionId }, correlationId);
      return { selectedRevisionId: revisionId };
    });
  }

  async createPublisher(actor: AuthenticatedSession, input: PublisherInput, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      if (input.ownerType === "personal" && input.ownerId !== actor.accountId) throw new DomainError("publisher_owner_invalid", "A personal publisher must be owned by the authenticated account.", 403);
      if (input.ownerType === "organisation") {
        const owner = await client.query(`SELECT 1 FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.organisation_id = $1 AND m.account_id = $2 AND m.status = 'active' AND r.role_key = 'owner'`, [input.ownerId, actor.accountId]);
        if (!owner.rowCount) throw new DomainError("publisher_owner_invalid", "Only an organisation owner can create its publisher profile.", 403);
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO publishers(public_id, owner_type, owner_id, public_name, slug, description, website, support_contact, security_contact)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [input.publicId, input.ownerType, input.ownerId, input.publicName, input.slug, input.description, input.website, input.supportContact, input.securityContact]
      );
      for (const permission of ["admin", "submit", "view", "manage_keys", "security"]) await client.query(`INSERT INTO publisher_members(publisher_id, account_id, permission) VALUES($1,$2,$3)`, [result.rows[0].id, actor.accountId, permission]);
      await appendPlatformAudit(client, actor, "publisher.created", "publisher", result.rows[0].id, { publicId: input.publicId, ownerType: input.ownerType, ownerId: input.ownerId }, correlationId);
      return { id: result.rows[0].id, publicId: input.publicId, slug: input.slug, verificationStatus: "unverified" as const };
    });
  }

  async registerPublisherSigningKey(actor: AuthenticatedSession, publisherId: string, keyId: string, publicKeyDerBase64: string, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      await requirePublisherPermission(client, actor.accountId, publisherId, ["admin", "manage_keys"]);
      await client.query(`INSERT INTO publisher_signing_keys(publisher_id, key_id, algorithm, public_key) VALUES($1,$2,'ed25519',decode($3,'base64'))`, [publisherId, keyId, publicKeyDerBase64]);
      await appendPlatformAudit(client, actor, "publisher.signing_key_registered", "publisher_signing_key", `${publisherId}:${keyId}`, { publisherId, keyId, algorithm: "ed25519" }, correlationId);
      return { publisherId, keyId, algorithm: "ed25519" as const };
    });
  }

  async createPluginSubmission(actor: AuthenticatedSession, input: PluginSubmissionInput, objectKey: string, correlationId: string): Promise<PluginSubmissionRecord> {
    return this.withAccount(actor.accountId, async client => {
      const publisher = await requirePublisherPermission(client, actor.accountId, input.publisherId, ["admin", "submit"]);
      const key = await client.query(`SELECT 1 FROM publisher_signing_keys WHERE publisher_id = $1 AND key_id = $2 AND revoked_at IS NULL`, [input.publisherId, input.publisherKeyId]);
      if (!key.rowCount) throw new DomainError("publisher_key_not_active", "The manifest signing key is not registered or has been revoked.", 409);
      if (input.manifest.publisherId !== publisher.public_id || input.manifest.pluginId !== input.pluginId || input.manifest.version !== input.version || input.manifest.packageIntegrity !== input.packageIntegrity) {
        throw new DomainError("manifest_identity_mismatch", "Submission identity, version, integrity, and publisher must exactly match the manifest.", 400);
      }
      await client.query(
        `INSERT INTO plugins(id, publisher_id, visibility, owner_type, owner_id, name, summary)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(id) DO NOTHING`,
        [input.pluginId, input.publisherId, input.visibility, input.ownerType, input.ownerId, input.name, input.summary]
      );
      const plugin = await client.query<{ publisher_id: string }>(`SELECT publisher_id FROM plugins WHERE id = $1`, [input.pluginId]);
      if (!plugin.rowCount || plugin.rows[0].publisher_id !== input.publisherId) throw new DomainError("plugin_id_owned", "This immutable plugin ID belongs to another publisher.", 409);
      const version = await client.query<{ id: string }>(
        `INSERT INTO plugin_versions(plugin_id, version, manifest_version, manifest, package_integrity, package_object_key, package_size, publisher_key_id, minimum_host_version, maximum_host_version, capabilities, network_domains, dependency_inventory, reproducibility)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [input.pluginId, input.version, input.manifestVersion, input.manifest, input.packageIntegrity, objectKey, input.packageSize, input.publisherKeyId, input.minimumHostVersion, input.maximumHostVersion, input.capabilities, input.networkDomains, input.dependencyInventory, input.reproducibility]
      ).catch(error => {
        if ((error as { code?: string }).code === "23505") throw new DomainError("plugin_version_immutable", "This plugin version or package digest already exists and cannot be replaced.", 409);
        throw error;
      });
      const review = await client.query<{ id: string }>(`INSERT INTO plugin_reviews(plugin_version_id, status) VALUES($1, 'draft') RETURNING id`, [version.rows[0].id]);
      await appendPlatformAudit(client, actor, "plugin.submission_created", "plugin_review", review.rows[0].id, { pluginId: input.pluginId, version: input.version, integrity: input.packageIntegrity }, correlationId);
      return { reviewId: review.rows[0].id, pluginVersionId: version.rows[0].id, publisherPublicId: publisher.public_id, publisherKeyId: input.publisherKeyId, pluginId: input.pluginId, version: input.version, packageIntegrity: input.packageIntegrity, packageSize: input.packageSize, packageObjectKey: objectKey, status: "draft" };
    });
  }

  async getPluginSubmission(actor: AuthenticatedSession, publisherId: string, reviewId: string): Promise<PluginSubmissionRecord | null> {
    return this.withAccount(actor.accountId, async client => {
      await requirePublisherPermission(client, actor.accountId, publisherId, ["admin", "submit", "view"]);
      const result = await client.query<SubmissionRow>(
        `SELECT pr.id AS review_id, pv.id AS plugin_version_id, p.public_id AS publisher_public_id, pv.publisher_key_id,
                pv.plugin_id, pv.version, pv.package_integrity, pv.package_size, pv.package_object_key, pr.status::text
           FROM plugin_reviews pr JOIN plugin_versions pv ON pv.id = pr.plugin_version_id
           JOIN plugins pl ON pl.id = pv.plugin_id JOIN publishers p ON p.id = pl.publisher_id
          WHERE pr.id = $1 AND p.id = $2`, [reviewId, publisherId]
      );
      return result.rowCount ? submissionFromRow(result.rows[0]) : null;
    });
  }

  async recordAutomatedPluginReview(actor: AuthenticatedSession, publisherId: string, reviewId: string, results: Record<string, unknown>, passed: boolean, rejectionReasons: string[], correlationId: string): Promise<PluginSubmissionRecord> {
    return this.withAccount(actor.accountId, async client => {
      await requirePublisherPermission(client, actor.accountId, publisherId, ["admin", "submit"]);
      const updated = await client.query<SubmissionRow>(
        `UPDATE plugin_reviews pr SET status = $1, automated_results = $2, rejection_reasons = $3, submitted_at = COALESCE(submitted_at, now()), updated_at = now()
          FROM plugin_versions pv, plugins pl, publishers p
         WHERE pr.id = $4 AND pv.id = pr.plugin_version_id AND pl.id = pv.plugin_id AND p.id = pl.publisher_id AND p.id = $5 AND pr.status IN ('draft','submitted','automated_review','changes_requested')
         RETURNING pr.id AS review_id, pv.id AS plugin_version_id, p.public_id AS publisher_public_id, pv.publisher_key_id,
                   pv.plugin_id, pv.version, pv.package_integrity, pv.package_size, pv.package_object_key, pr.status::text`,
        [passed ? "manual_review" : "changes_requested", results, rejectionReasons, reviewId, publisherId]
      );
      if (!updated.rowCount) throw new DomainError("review_state_invalid", "This review cannot be submitted from its current state.", 409);
      await appendPlatformAudit(client, actor, passed ? "plugin.automated_review_passed" : "plugin.changes_requested", "plugin_review", reviewId, { rejectionReasons }, correlationId);
      return submissionFromRow(updated.rows[0]);
    });
  }

  async publishPluginVersion(actor: AuthenticatedSession, publisherId: string, reviewId: string, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      await requirePublisherPermission(client, actor.accountId, publisherId, ["admin", "submit"]);
      const reviewed = await client.query<{ plugin_version_id: string; plugin_id: string; version: string }>(
        `SELECT pr.plugin_version_id, pv.plugin_id, pv.version FROM plugin_reviews pr
          JOIN plugin_versions pv ON pv.id = pr.plugin_version_id JOIN plugins pl ON pl.id = pv.plugin_id
         WHERE pr.id = $1 AND pl.publisher_id = $2 AND pr.status = 'approved' AND pv.revoked_at IS NULL FOR UPDATE`, [reviewId, publisherId]
      );
      if (!reviewed.rowCount) throw new DomainError("review_not_publishable", "Only an approved, non-revoked version owned by this publisher can be published.", 409);
      const item = reviewed.rows[0];
      await client.query(
        `INSERT INTO plugin_listings(plugin_id,current_version_id,categories,keywords,pricing,licence,documentation_url,privacy_policy_url,support_url)
         SELECT pv.plugin_id,pv.id,
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(pv.manifest->'categories','[]'::jsonb))),
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(pv.manifest->'keywords','[]'::jsonb))),
                COALESCE(pv.manifest->'pricing','{"model":"free"}'::jsonb),
                pv.manifest->>'licence',pv.manifest->>'documentation',pv.manifest->>'privacyPolicy',pv.manifest->>'supportUrl'
           FROM plugin_versions pv WHERE pv.id = $1
         ON CONFLICT(plugin_id) DO UPDATE SET current_version_id=excluded.current_version_id,categories=excluded.categories,keywords=excluded.keywords,pricing=excluded.pricing,licence=excluded.licence,documentation_url=excluded.documentation_url,privacy_policy_url=excluded.privacy_policy_url,support_url=excluded.support_url,updated_at=now(),suspended_at=NULL,removed_at=NULL`,
        [item.plugin_version_id]
      );
      await client.query(`UPDATE plugin_reviews SET status='published',published_at=now(),updated_at=now() WHERE id=$1`, [reviewId]);
      await appendPlatformAudit(client, actor, "plugin.version_published", "plugin_version", item.plugin_version_id, { pluginId: item.plugin_id, version: item.version }, correlationId);
      return { pluginId: item.plugin_id, version: item.version, status: "published" as const };
    });
  }

  async decidePluginReview(actor: AuthenticatedSession, reviewId: string, decision: "approved" | "changes_requested" | "rejected", reasons: string[], correlationId: string): Promise<void> {
    await this.withAccount(actor.accountId, async client => {
      const result = await client.query(`UPDATE plugin_reviews SET status = $1, rejection_reasons = $2, assigned_reviewer = $3, decided_at = CASE WHEN $1 IN ('approved','rejected') THEN now() ELSE decided_at END, updated_at = now() WHERE id = $4 AND status IN ('manual_review','changes_requested')`, [decision, reasons, actor.accountId, reviewId]);
      if (!result.rowCount) throw new DomainError("review_state_invalid", "Only a manual-review submission can receive this decision.", 409);
      await appendPlatformAudit(client, actor, `plugin.review_${decision}`, "plugin_review", reviewId, { reasons }, correlationId);
    });
  }

  async revokePluginVersion(actor: AuthenticatedSession, pluginVersionId: string, reason: string, securityNoticeUrl: string, correlationId: string): Promise<void> {
    await this.withAccount(actor.accountId, async client => {
      const version = await client.query<{ plugin_id: string }>(`UPDATE plugin_versions SET revoked_at = now(), revocation_reason = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING plugin_id`, [reason, pluginVersionId]);
      if (!version.rowCount) throw new DomainError("plugin_version_not_found", "Plugin version not found or already revoked.", 404);
      await client.query(`UPDATE plugin_reviews SET status = 'suspended', updated_at = now() WHERE plugin_version_id = $1`, [pluginVersionId]);
      await client.query(`UPDATE plugin_listings SET security_notices = security_notices || $1::jsonb, suspended_at = CASE WHEN current_version_id = $2 THEN now() ELSE suspended_at END WHERE plugin_id = $3`, [JSON.stringify([{ versionId: pluginVersionId, reason, url: securityNoticeUrl, publishedAt: new Date().toISOString() }]), pluginVersionId, version.rows[0].plugin_id]);
      await appendPlatformAudit(client, actor, "plugin.version_revoked", "plugin_version", pluginVersionId, { reason, securityNoticeUrl }, correlationId);
    });
  }

  async searchMarketplace(actor: AuthenticatedSession | null, query: MarketplaceQuery) {
    const client = await this.pool.connect();
    try {
      const order = marketplaceOrder(query.sort);
      // Keep the parameter positions stable for every marketplace query. PostgreSQL
      // cannot infer the type of a completely unused $9 parameter on the first page.
      const cursorClause = query.cursor
        ? marketplaceCursorClause(query.sort)
        : "AND $9::text IS NULL";
      const result = await client.query<MarketplaceRow>(
        `SELECT pl.id AS plugin_id, pl.name, pl.summary, pl.visibility, p.public_id AS publisher_public_id, p.public_name,
                (p.verification_status = 'verified') AS publisher_verified, pv.version, pv.package_integrity,
                l.categories, l.keywords, l.pricing, l.licence, l.documentation_url, l.privacy_policy_url, l.support_url,
                l.screenshots, l.security_notices, pv.capabilities, pv.network_domains, pv.manifest->'nodes' AS nodes,
                pv.minimum_host_version, pv.maximum_host_version, l.install_count, l.rating_average, l.rating_count, l.updated_at
           FROM plugin_listings l JOIN plugins pl ON pl.id = l.plugin_id
           JOIN plugin_versions pv ON pv.id = l.current_version_id JOIN plugin_reviews pr ON pr.plugin_version_id = pv.id
           JOIN publishers p ON p.id = pl.publisher_id
          WHERE pr.status = 'published' AND pv.revoked_at IS NULL AND l.suspended_at IS NULL AND l.removed_at IS NULL
            AND ($1::text IS NULL OR pl.id = $1 OR pl.name ILIKE '%' || $1 || '%' OR pl.summary ILIKE '%' || $1 || '%' OR p.public_name ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR $2 = ANY(l.categories))
            AND ($3::text = 'all' OR ($3 = 'free' AND l.pricing->>'model' = 'free') OR ($3 = 'paid' AND l.pricing->>'model' <> 'free'))
            AND (NOT $4::boolean OR p.verification_status = 'verified')
            AND (pl.visibility = 'public' OR ($5::text IN ('workspace','all') AND $6::uuid IS NOT NULL AND $7::uuid IS NOT NULL
                 AND EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id = $6 AND wm.account_id = $7)
                 AND ((pl.visibility = 'organisation' AND pl.owner_id = (SELECT organisation_id FROM workspaces WHERE id = $6))
                      OR (pl.visibility = 'selected_workspaces' AND EXISTS(SELECT 1 FROM plugin_visibility_workspaces vw WHERE vw.plugin_id = pl.id AND vw.workspace_id = $6)))))
            AND (NOT $8::boolean OR ($6::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM governance_policies gp WHERE gp.workspace_id = $6 AND gp.policy_key = 'permitted_plugins' AND gp.policy_value->'pluginIds' ? pl.id)))
            ${cursorClause}
          ORDER BY ${order} LIMIT $10`,
        [query.search, query.category, query.pricing, query.verifiedOnly, query.visibility, query.workspaceId, actor?.accountId ?? null, query.teamApprovedOnly, query.cursor, query.limit * 3 + 1]
      );
      const compatible = result.rows.filter(row => hostCompatible(query.hostVersion, row.minimum_host_version, row.maximum_host_version));
      const page = compatible.slice(0, query.limit);
      return { items: page.map(marketplaceFromRow), nextCursor: compatible.length > query.limit ? page.at(-1)!.plugin_id : null };
    } finally {
      client.release();
    }
  }

  async getMarketplaceListing(actor: AuthenticatedSession | null, pluginId: string, workspaceId: string | null) {
    const result = await this.searchMarketplace(actor, { search: pluginId, category: null, pricing: "all", verifiedOnly: false, visibility: workspaceId ? "all" : "public", workspaceId, teamApprovedOnly: false, sort: "recent", cursor: null, limit: 1, hostVersion: "0.5.0" });
    return result.items.find(item => item.pluginId === pluginId) ?? null;
  }

  async getMarketplacePackage(actor: AuthenticatedSession | null, pluginId: string, workspaceId: string | null): Promise<MarketplacePackage | null> {
    if (!await this.getMarketplaceListing(actor, pluginId, workspaceId)) return null;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        plugin_id: string; version: string; package_integrity: string; package_size: string | number; package_object_key: string;
        publisher_public_id: string; publisher_key_id: string; publisher_public_key_der_base64: string; pricing_model: string;
      }>(`SELECT pv.plugin_id,pv.version,pv.package_integrity,pv.package_size,pv.package_object_key,p.public_id AS publisher_public_id,
                 pv.publisher_key_id,encode(psk.public_key,'base64') AS publisher_public_key_der_base64,l.pricing->>'model' AS pricing_model
            FROM plugin_listings l JOIN plugin_versions pv ON pv.id=l.current_version_id JOIN plugins pl ON pl.id=pv.plugin_id
            JOIN publishers p ON p.id=pl.publisher_id JOIN publisher_signing_keys psk ON psk.publisher_id=p.id AND psk.key_id=pv.publisher_key_id
            JOIN plugin_reviews pr ON pr.plugin_version_id=pv.id
           WHERE pv.plugin_id=$1 AND pr.status='published' AND pv.revoked_at IS NULL AND psk.revoked_at IS NULL AND l.suspended_at IS NULL AND l.removed_at IS NULL`, [pluginId]);
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return { pluginId: row.plugin_id, version: row.version, packageIntegrity: row.package_integrity, packageSize: Number(row.package_size), packageObjectKey: row.package_object_key, publisherPublicId: row.publisher_public_id, publisherKeyId: row.publisher_key_id, publisherPublicKeyDerBase64: row.publisher_public_key_der_base64.replace(/\s/g, ""), pricingModel: row.pricing_model };
    } finally {
      client.release();
    }
  }

  async listAuditEvents(actor: AuthenticatedSession, workspaceId: string, cursor: string | null, limit: number) {
    return this.withAccount(actor.accountId, async client => {
      const values: unknown[] = [workspaceId, limit + 1];
      const cursorClause = cursor ? "AND (occurred_at, id) < (SELECT occurred_at, id FROM audit_events WHERE id = $3)" : "";
      if (cursor) values.push(cursor);
      const result = await client.query<{
        id: string; occurred_at: Date; actor_account_id: string | null; action: string; resource_type: string; resource_id: string;
        before_summary: Record<string, unknown> | null; after_summary: Record<string, unknown> | null; source_device_id: string | null; correlation_id: string;
      }>(`SELECT id, occurred_at, actor_account_id, action, resource_type, resource_id, before_summary, after_summary, source_device_id, correlation_id
            FROM audit_events WHERE workspace_id = $1 ${cursorClause} ORDER BY occurred_at DESC, id DESC LIMIT $2`, values);
      const page = result.rows.slice(0, limit);
      return {
        items: page.map(row => ({ eventId: row.id, timestamp: row.occurred_at.toISOString(), actorAccountId: row.actor_account_id, workspaceId, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, beforeSummary: row.before_summary, afterSummary: row.after_summary, sourceDeviceId: row.source_device_id, correlationId: row.correlation_id } satisfies AuditEvent)),
        nextCursor: result.rows.length > limit ? page.at(-1)!.id : null
      };
    });
  }

  async exportAccountData(actor: AuthenticatedSession) {
    return this.withAccount(actor.accountId, async client => {
      const account = await client.query(`SELECT id, primary_email, email_verified, display_name, created_at FROM accounts WHERE id = $1`, [actor.accountId]);
      const memberships = await client.query(`SELECT organisation_id, role_id, status, joined_at FROM memberships WHERE account_id = $1`, [actor.accountId]);
      const sessions = await client.query(`SELECT id, device_name, created_at, last_seen_at, expires_at, revoked_at FROM account_sessions WHERE account_id = $1`, [actor.accountId]);
      return { exportedAt: new Date().toISOString(), account: account.rows[0] ?? null, memberships: memberships.rows, sessions: sessions.rows };
    });
  }

  async requestAccountDeletion(actor: AuthenticatedSession, correlationId: string): Promise<void> {
    await this.withAccount(actor.accountId, async client => {
      const owned = await client.query(`SELECT 1 FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.account_id = $1 AND r.role_key = 'owner' AND m.status = 'active'`, [actor.accountId]);
      if (owned.rowCount) throw new DomainError("ownership_transfer_required", "Transfer or delete owned organisations before deleting the account.", 409);
      await client.query(`UPDATE account_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [actor.accountId]);
      await client.query(`UPDATE accounts SET deleted_at = now(), primary_email = concat('deleted+', id, '@invalid.local'), display_name = 'Deleted account' WHERE id = $1`, [actor.accountId]);
      void correlationId;
    });
  }

  async listSessions(actor: AuthenticatedSession) {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{ id: string; device_name: string; created_at: Date; last_seen_at: Date; expires_at: Date }>(
        `SELECT id, device_name, created_at, last_seen_at, expires_at FROM account_sessions WHERE account_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`, [actor.accountId]
      );
      return result.rows.map(row => ({ id: row.id, deviceName: row.device_name, createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), expiresAt: row.expires_at.toISOString(), current: row.id === actor.sessionId }));
    });
  }

  async revokeSession(actor: AuthenticatedSession, sessionId: string, correlationId: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query(`UPDATE account_sessions SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`, [sessionId, actor.accountId]);
      void correlationId;
      return (result.rowCount ?? 0) > 0;
    });
  }

  async createRunnerPairingChallenge(actor: AuthenticatedSession, input: RunnerPairingChallengeInput, challenge: string, expiresAt: Date) {
    return this.withAccount(actor.accountId, async client => {
      const challengeId = randomUUID();
      const metadata = { operatingSystem: input.operatingSystem, architecture: input.architecture, applicationVersion: input.applicationVersion, protocolVersion: input.protocolVersion, pluginRuntimeVersion: input.pluginRuntimeVersion, capabilities: input.capabilities, safeFolderLabels: input.safeFolderLabels, browserEngine: input.browserEngine, installedPluginVersions: input.installedPluginVersions, tags: input.tags };
      await client.query(
        `INSERT INTO runner_pairing_challenges(id, account_id, challenge_hash, device_public_key, expires_at, metadata)
         VALUES($1,$2,$3,decode($4,'base64'),$5,$6)`,
        [challengeId, actor.accountId, createHash("sha256").update(challenge, "utf8").digest(), input.devicePublicKeyDerBase64, expiresAt, metadata]
      );
      return { challengeId, challenge, expiresAt: expiresAt.toISOString() };
    });
  }

  async confirmRunnerPairing(actor: AuthenticatedSession, input: RunnerPairingConfirmationInput, correlationId: string): Promise<RunnerRecord> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{ device_public_key: Buffer; challenge_hash: Buffer; metadata: RunnerPairingMetadata }>(
        `SELECT device_public_key, challenge_hash, metadata FROM runner_pairing_challenges
          WHERE id=$1 AND account_id=$2 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
        [input.challengeId, actor.accountId]
      );
      if (!result.rowCount) throw new DomainError("pairing_challenge_invalid", "Pairing challenge is expired, consumed, or unavailable.", 409);
      const challengeHash = createHash("sha256").update(input.challenge, "utf8").digest();
      if (!challengeHash.equals(result.rows[0].challenge_hash)) throw new DomainError("pairing_challenge_invalid", "Pairing challenge does not match.", 403);
      const publicKey = createPublicKey({ key: result.rows[0].device_public_key, format: "der", type: "spki" });
      if (!verify(null, Buffer.from(input.challenge, "utf8"), publicKey, Buffer.from(input.signatureBase64, "base64"))) throw new DomainError("pairing_signature_invalid", "Runner did not prove possession of the device private key.", 403);
      if (input.workspaceId) {
        const membership = await client.query(`SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND account_id=$2`, [input.workspaceId, actor.accountId]);
        if (!membership.rowCount) throw new DomainError("workspace_not_found", "Workspace not found or not accessible.", 404);
      }
      const metadata = result.rows[0].metadata;
      const runnerId = randomUUID();
      // The freshly paired runner derives this identifier from its returned ID.
      const keyId = `device-${runnerId}`;
      const inserted = await client.query<{ paired_at: Date }>(
        `INSERT INTO runners(id,account_id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'offline') RETURNING paired_at`,
        [runnerId, actor.accountId, input.workspaceId, input.displayName, metadata.operatingSystem, metadata.architecture, metadata.applicationVersion, metadata.protocolVersion, metadata.pluginRuntimeVersion, metadata.capabilities, metadata.safeFolderLabels, metadata.browserEngine, metadata.installedPluginVersions, metadata.tags]
      );
      await client.query(`INSERT INTO runner_device_keys(runner_id,key_id,algorithm,public_key) VALUES($1,$2,'ed25519',$3)`, [runnerId, keyId, result.rows[0].device_public_key]);
      await client.query(`UPDATE runner_pairing_challenges SET consumed_at=now() WHERE id=$1`, [input.challengeId]);
      if (input.workspaceId) await appendAudit(client, actor, input.workspaceId, "runner.paired", "runner", runnerId, null, { displayName: input.displayName, operatingSystem: metadata.operatingSystem, architecture: metadata.architecture }, correlationId);
      return { runnerId, displayName: input.displayName, workspaceId: input.workspaceId, ...metadata, status: "offline", currentWorkload: 0, pairedAt: inserted.rows[0].paired_at.toISOString(), lastSeenAt: null };
    });
  }

  async listRunners(actor: AuthenticatedSession, workspaceId: string): Promise<RunnerRecord[]> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<RunnerRow>(`SELECT id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status,current_workload,paired_at,last_seen_at FROM runners WHERE workspace_id=$1 AND revoked_at IS NULL ORDER BY display_name,id`, [workspaceId]);
      return result.rows.map(runnerFromRow);
    });
  }

  async createRunnerCommand(actor: AuthenticatedSession, input: RunnerCommandInput, correlationId: string): Promise<RunnerCommand> {
    return this.withAccount(actor.accountId, async client => {
      const existing = await client.query<RunnerCommandRow>(`SELECT id,issuer_account_id,workspace_id,target_runner_id,action,workflow_revision_id,convert_from(payload_ciphertext,'utf8')::jsonb AS payload,authorization_context,created_at,expires_at,idempotency_key,key_id,encode(signature,'base64') AS signature,status FROM runner_commands WHERE target_runner_id=$1 AND idempotency_key=$2 AND authorization_context IS NOT NULL`, [input.targetRunnerId, input.idempotencyKey]);
      if (existing.rowCount) return runnerCommandFromRow(existing.rows[0]);
      const runner = await client.query<{ status: string; installed_plugin_versions: Array<{ pluginId: string; version: string; packageIntegrity: string }> }>(`SELECT status,installed_plugin_versions FROM runners WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [input.targetRunnerId, input.workspaceId]);
      if (!runner.rowCount) throw new DomainError("runner_not_found", "Target runner is not registered in this workspace.", 404);
      if (!["online", "offline"].includes(runner.rows[0].status)) throw new DomainError("runner_unavailable", `Runner is ${runner.rows[0].status} and cannot accept new execution commands.`, 409);
      if (new Date(input.expiresAt).getTime() <= Date.now()) throw new DomainError("command_expired", "Runner command expiry must be in the future.", 400);
      if (["run_workflow", "sync_revision"].includes(input.action)) {
        if (!input.workflowRevisionId) throw new DomainError("workflow_revision_required", "This command requires an exact approved workflow revision.", 400);
        const revision = await client.query<{ workflow_id: string; content_hash: string; plugin_requirements: Array<{ pluginId: string; version: string; packageIntegrity: string }> }>(
          `SELECT r.workflow_id,r.content_hash,r.plugin_requirements FROM workflow_revisions r JOIN synced_workflows w ON w.id=r.workflow_id
            WHERE r.id=$1 AND w.workspace_id=$2 AND r.publish_status IN ('approved','published')`, [input.workflowRevisionId, input.workspaceId]
        );
        if (!revision.rowCount) throw new DomainError("workflow_revision_not_approved", "The exact workflow revision is not approved in this workspace.", 409);
        if (input.action === "run_workflow") {
          if (!executablePayloadMatchesRevision(input.payload, input.workflowRevisionId, revision.rows[0].workflow_id, revision.rows[0].content_hash)) {
            throw new DomainError("workflow_payload_revision_mismatch", "The executable workflow payload must match the exact approved revision identity and content hash.", 409);
          }
        }
        const missing = incompatiblePluginRequirements(revision.rows[0].plugin_requirements, runner.rows[0].installed_plugin_versions);
        if (missing.length) throw new DomainError("runner_incompatible", `Runner is missing exact plugin requirements: ${missing.join(", ")}.`, 409);
      }
      await client.query(
        `INSERT INTO runner_commands(id,issuer_account_id,workspace_id,target_runner_id,action,workflow_revision_id,payload_ciphertext,authorization_context,created_at,expires_at,idempotency_key,key_id,signature,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,decode($13,'base64'),'queued')`,
        [input.commandId, actor.accountId, input.workspaceId, input.targetRunnerId, input.action, input.workflowRevisionId, Buffer.from(JSON.stringify(input.payload), "utf8"), input.authorizationContext, input.createdAt, input.expiresAt, input.idempotencyKey, input.keyId, input.signature]
      );
      await appendAudit(client, actor, input.workspaceId, "remote_execution.requested", "runner_command", input.commandId, null, { runnerId: input.targetRunnerId, action: input.action, workflowRevisionId: input.workflowRevisionId, expiresAt: input.expiresAt, idempotencyKey: input.idempotencyKey }, correlationId);
      return { ...input, issuerAccountId: actor.accountId, status: "queued" };
    });
  }

  async revokeRunner(actor: AuthenticatedSession, workspaceId: string, runnerId: string, correlationId: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query(`UPDATE runners SET status='revoked',revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`, [runnerId, workspaceId]);
      if (!result.rowCount) return false;
      await client.query(`UPDATE runner_device_keys SET revoked_at=now() WHERE runner_id=$1 AND revoked_at IS NULL`, [runnerId]);
      await client.query(`UPDATE runner_commands SET status='expired' WHERE target_runner_id=$1 AND status IN ('queued','delivered')`, [runnerId]);
      await appendAudit(client, actor, workspaceId, "runner.revoked", "runner", runnerId, null, { localDataDeleted: false }, correlationId);
      return true;
    });
  }

  async requestWorkflowApproval(actor: AuthenticatedSession, workspaceId: string, workflowId: string, revisionId: string, correlationId: string): Promise<WorkflowApprovalRecord> {
    return this.withAccount(actor.accountId, async client => {
      const revision = await client.query<{ publish_status: string; current_draft_revision_id: string | null }>(
        `SELECT r.publish_status,w.current_draft_revision_id FROM workflow_revisions r JOIN synced_workflows w ON w.id=r.workflow_id
          WHERE r.id=$1 AND r.workflow_id=$2 AND w.workspace_id=$3 FOR UPDATE`, [revisionId, workflowId, workspaceId]
      );
      if (!revision.rowCount) throw new DomainError("revision_not_found", "Workflow revision not found in this workspace.", 404);
      if (revision.rows[0].current_draft_revision_id !== revisionId) throw new DomainError("revision_not_current_draft", "Only the current draft can be submitted for approval.", 409);
      if (!["draft", "rejected", "approval_requested"].includes(revision.rows[0].publish_status)) throw new DomainError("workflow_state_invalid", "This revision is not an editable draft.", 409);
      const existing = await client.query<ApprovalRow>(`SELECT id,workflow_id,revision_id,status,created_at FROM workflow_approvals WHERE workspace_id=$1 AND workflow_id=$2 AND revision_id=$3 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [workspaceId, workflowId, revisionId]);
      const requiredApprovals = await requiredApprovalCount(client, workspaceId);
      if (existing.rowCount) return approvalFromRow(existing.rows[0], requiredApprovals, 0);
      const approval = await client.query<ApprovalRow>(
        `INSERT INTO workflow_approvals(workspace_id,workflow_id,revision_id,status,requested_by) VALUES($1,$2,$3,'pending',$4) RETURNING id,workflow_id,revision_id,status,created_at`,
        [workspaceId, workflowId, revisionId, actor.accountId]
      );
      await client.query(`UPDATE workflow_revisions SET publish_status='approval_requested' WHERE id=$1`, [revisionId]);
      await appendAudit(client, actor, workspaceId, "workflow.approval_requested", "workflow_revision", revisionId, null, { workflowId, requiredApprovals }, correlationId);
      return approvalFromRow(approval.rows[0], requiredApprovals, 0);
    });
  }

  async listWorkflowApprovals(actor: AuthenticatedSession, workspaceId: string, status: "all" | "pending" | "approved" | "rejected"): Promise<WorkflowApprovalRecord[]> {
    return this.withAccount(actor.accountId, async client => {
      const requiredApprovals = await requiredApprovalCount(client, workspaceId);
      const result = await client.query<ApprovalRow & {approval_count:string}>(
        `SELECT approval.id, approval.workflow_id, approval.revision_id, approval.status,
                approval.created_at, count(vote.account_id) FILTER (WHERE vote.decision = 'approved')::text AS approval_count
           FROM workflow_approvals approval
           LEFT JOIN workflow_approval_votes vote ON vote.approval_id = approval.id
          WHERE approval.workspace_id = $1 AND ($2 = 'all' OR approval.status = $2)
          GROUP BY approval.id
          ORDER BY approval.created_at DESC
          LIMIT 200`,
        [workspaceId, status]
      );
      return result.rows.map(row => approvalFromRow(row, requiredApprovals, Number(row.approval_count)));
    });
  }

  async decideWorkflowApproval(actor: AuthenticatedSession, workspaceId: string, approvalId: string, decision: "approved" | "rejected", reason: string | null, correlationId: string): Promise<WorkflowApprovalRecord> {
    return this.withAccount(actor.accountId, async client => {
      const approval = await client.query<ApprovalRow>(`SELECT id,workflow_id,revision_id,status,created_at FROM workflow_approvals WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [approvalId, workspaceId]);
      if (!approval.rowCount) throw new DomainError("approval_not_found", "Workflow approval was not found in this workspace.", 404);
      if (approval.rows[0].status !== "pending") throw new DomainError("approval_already_resolved", "Workflow approval is no longer pending.", 409);
      const inserted = await client.query(
        `INSERT INTO workflow_approval_votes(approval_id,account_id,decision,reason) VALUES($1,$2,$3,$4)
         ON CONFLICT(approval_id,account_id) DO NOTHING`, [approvalId, actor.accountId, decision, reason]
      );
      if (!inserted.rowCount) throw new DomainError("approval_already_voted", "You have already decided this approval request.", 409);
      const requiredApprovals = await requiredApprovalCount(client, workspaceId);
      const votes = await client.query<{ decision: "approved" | "rejected"; count: string }>(`SELECT decision,count(*)::text AS count FROM workflow_approval_votes WHERE approval_id=$1 GROUP BY decision`, [approvalId]);
      const approvalCount = Number(votes.rows.find(row => row.decision === "approved")?.count ?? 0);
      const rejected = votes.rows.some(row => row.decision === "rejected");
      let status: WorkflowApprovalRecord["status"] = "pending";
      if (rejected) status = "rejected";
      else if (approvalCount >= requiredApprovals) status = "approved";
      if (status !== "pending") {
        await client.query(`UPDATE workflow_approvals SET status=$1,resolved_by=$2,reason=$3,resolved_at=now() WHERE id=$4`, [status, actor.accountId, reason, approvalId]);
        await client.query(`UPDATE workflow_revisions SET publish_status=$1 WHERE id=$2`, [status, approval.rows[0].revision_id]);
      }
      await appendAudit(client, actor, workspaceId, `workflow.approval_${decision}`, "workflow_approval", approvalId, null, { workflowId: approval.rows[0].workflow_id, revisionId: approval.rows[0].revision_id, approvalCount, requiredApprovals, status, reason }, correlationId);
      return approvalFromRow({ ...approval.rows[0], status }, requiredApprovals, approvalCount);
    });
  }

  async publishWorkflowRevision(actor: AuthenticatedSession, workspaceId: string, workflowId: string, revisionId: string, changeSummary: string, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const workflow = await client.query<{ current_published_revision_id: string | null; current_draft_revision_id: string | null }>(`SELECT current_published_revision_id,current_draft_revision_id FROM synced_workflows WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [workflowId, workspaceId]);
      if (!workflow.rowCount) throw new DomainError("workflow_not_found", "Workflow not found in this workspace.", 404);
      if (workflow.rows[0].current_draft_revision_id !== revisionId) throw new DomainError("revision_not_current_draft", "Only the current draft can be published.", 409);
      const revision = await client.query<{ publish_status: string; permission_requirements:string[]; content_hash:string }>(`SELECT publish_status,permission_requirements,content_hash FROM workflow_revisions WHERE id=$1 AND workflow_id=$2`, [revisionId, workflowId]);
      if (!revision.rowCount || revision.rows[0].publish_status !== "approved") throw new DomainError("workflow_approval_required", "The exact draft revision must satisfy workspace approval policy before publication.", 409);
      const missing = await client.query<{ plugin_id: string; version: string }>(
        `SELECT requirement->>'pluginId' AS plugin_id,requirement->>'version' AS version
           FROM workflow_revisions r,CROSS JOIN LATERAL jsonb_array_elements(r.plugin_requirements) requirement
          WHERE r.id=$1 AND NOT EXISTS (
            SELECT 1 FROM plugin_installations installation JOIN plugin_versions pv ON pv.id=installation.plugin_version_id
             WHERE installation.workspace_id=$2 AND installation.enabled AND pv.plugin_id=requirement->>'pluginId' AND pv.version=requirement->>'version' AND pv.package_integrity=requirement->>'packageIntegrity' AND pv.revoked_at IS NULL
          )`, [revisionId, workspaceId]
      );
      if (missing.rowCount) throw new DomainError("workflow_plugin_requirements_missing", `Workspace is missing enabled exact plugin versions: ${missing.rows.map(row => `${row.plugin_id}@${row.version}`).join(", ")}.`, 409);
      const permissionSnapshotId=randomUUID();
      const permissionRequirements=revision.rows[0].permission_requirements;
      const networkTargets=permissionRequirements.filter(value=>value.startsWith("network:")).map(value=>value.slice("network:".length));
      const snapshot=await client.query<{id:string}>(`INSERT INTO workflow_permission_snapshots(id,workspace_id,workflow_id,workflow_revision_id,permissions,network_targets,data_egress_summary,approved_by,approved_at,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) ON CONFLICT(workflow_revision_id,content_hash) DO UPDATE SET revoked_at=NULL RETURNING id`,[permissionSnapshotId,workspaceId,workflowId,revisionId,permissionRequirements,networkTargets,networkTargets.length?["Workflow may send data to approved network targets."]:[],actor.accountId,revision.rows[0].content_hash]);
      const previousPublishedRevisionId = workflow.rows[0].current_published_revision_id;
      if (previousPublishedRevisionId) await client.query(`UPDATE workflow_revisions SET publish_status='rolled_back' WHERE id=$1`, [previousPublishedRevisionId]);
      await client.query(`UPDATE workflow_revisions SET publish_status='published',change_summary=$1 WHERE id=$2`, [changeSummary, revisionId]);
      await client.query(`UPDATE synced_workflows SET current_published_revision_id=$1 WHERE id=$2`, [revisionId, workflowId]);
      await appendAudit(client, actor, workspaceId, "workflow.published", "workflow_revision", revisionId, { previousPublishedRevisionId }, { workflowId, changeSummary }, correlationId);
      return { workflowId, publishedRevisionId: revisionId, previousPublishedRevisionId, permissionSnapshotId:snapshot.rows[0].id };
    });
  }

  async rollbackWorkflowRevision(actor: AuthenticatedSession, workspaceId: string, workflowId: string, revisionId: string, reason: string, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const workflow = await client.query<{ current_published_revision_id: string | null }>(`SELECT current_published_revision_id FROM synced_workflows WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [workflowId, workspaceId]);
      if (!workflow.rowCount) throw new DomainError("workflow_not_found", "Workflow not found in this workspace.", 404);
      const selected = await client.query<{ publish_status: string }>(`SELECT publish_status FROM workflow_revisions WHERE id=$1 AND workflow_id=$2`, [revisionId, workflowId]);
      if (!selected.rowCount || !["published", "rolled_back"].includes(selected.rows[0].publish_status)) throw new DomainError("rollback_revision_invalid", "Rollback target must be a previously published revision of this workflow.", 409);
      const previousPublishedRevisionId = workflow.rows[0].current_published_revision_id;
      if (previousPublishedRevisionId === revisionId) throw new DomainError("rollback_revision_current", "The selected revision is already published.", 409);
      if (previousPublishedRevisionId) await client.query(`UPDATE workflow_revisions SET publish_status='rolled_back' WHERE id=$1`, [previousPublishedRevisionId]);
      await client.query(`UPDATE workflow_revisions SET publish_status='published' WHERE id=$1`, [revisionId]);
      await client.query(`UPDATE synced_workflows SET current_published_revision_id=$1 WHERE id=$2`, [revisionId, workflowId]);
      await appendAudit(client, actor, workspaceId, "workflow.rolled_back", "workflow_revision", revisionId, { previousPublishedRevisionId }, { workflowId, reason }, correlationId);
      return { workflowId, publishedRevisionId: revisionId, previousPublishedRevisionId };
    });
  }

  async getGovernancePolicies(actor: AuthenticatedSession, workspaceId: string) {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{ policy_key: string; policy_value: unknown }>(`SELECT policy_key,policy_value FROM governance_policies WHERE workspace_id=$1 ORDER BY policy_key`, [workspaceId]);
      return Object.fromEntries(result.rows.map(row => [row.policy_key, row.policy_value]));
    });
  }

  async setGovernancePolicy(actor: AuthenticatedSession, workspaceId: string, policyKey: string, policyValue: unknown, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const existing = await client.query<{ policy_value: unknown }>(`SELECT policy_value FROM governance_policies WHERE workspace_id=$1 AND policy_key=$2 FOR UPDATE`, [workspaceId, policyKey]);
      await client.query(
        `INSERT INTO governance_policies(workspace_id,policy_key,policy_value,changed_by,changed_at) VALUES($1,$2,$3,$4,now())
         ON CONFLICT(workspace_id,policy_key) DO UPDATE SET policy_value=excluded.policy_value,changed_by=excluded.changed_by,changed_at=excluded.changed_at`,
        [workspaceId, policyKey, policyValue, actor.accountId]
      );
      await appendAudit(client, actor, workspaceId, "governance.policy_changed", "governance_policy", policyKey, { policyValue: existing.rows[0]?.policy_value ?? null }, { policyValue }, correlationId);
      return { policyKey, policyValue };
    });
  }

  async listWorkspaceMembers(actor: AuthenticatedSession, workspaceId: string) {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{ account_id: string; primary_email: string; display_name: string; role_key: BuiltInRole; joined_at: Date }>(
        `SELECT a.id AS account_id,a.primary_email,a.display_name,r.role_key,m.joined_at
           FROM workspace_memberships wm JOIN accounts a ON a.id=wm.account_id JOIN roles r ON r.id=wm.role_id
           JOIN memberships m ON m.account_id=wm.account_id AND m.organisation_id=r.organisation_id AND m.status='active'
          WHERE wm.workspace_id=$1 ORDER BY a.display_name,a.id`, [workspaceId]
      );
      return result.rows.map(row => ({ accountId: row.account_id, email: row.primary_email, displayName: row.display_name, role: row.role_key, joinedAt: row.joined_at.toISOString() }));
    });
  }

  async updateWorkspaceMemberRole(actor: AuthenticatedSession, workspaceId: string, accountId: string, role: BuiltInRole, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const member = await client.query<{ organisation_id: string; previous_role: BuiltInRole; primary_email: string; display_name: string; joined_at: Date }>(
        `SELECT w.organisation_id,r.role_key AS previous_role,a.primary_email,a.display_name,m.joined_at
           FROM workspace_memberships wm JOIN workspaces w ON w.id=wm.workspace_id JOIN roles r ON r.id=wm.role_id JOIN accounts a ON a.id=wm.account_id
           JOIN memberships m ON m.account_id=wm.account_id AND m.organisation_id=w.organisation_id AND m.status='active'
          WHERE wm.workspace_id=$1 AND wm.account_id=$2 FOR UPDATE`, [workspaceId, accountId]
      );
      if (!member.rowCount) throw new DomainError("member_not_found", "Member was not found in this workspace.", 404);
      const selectedRole = await client.query<{ id: string }>(`SELECT id FROM roles WHERE organisation_id=$1 AND role_key=$2 AND built_in`, [member.rows[0].organisation_id, role]);
      if (!selectedRole.rowCount) throw new DomainError("role_not_found", "Role is unavailable for this organisation.", 400);
      await client.query(`UPDATE workspace_memberships SET role_id=$1 WHERE workspace_id=$2 AND account_id=$3`, [selectedRole.rows[0].id, workspaceId, accountId]);
      await appendAudit(client, actor, workspaceId, "member.role_changed", "member", accountId, { role: member.rows[0].previous_role }, { role }, correlationId);
      return { accountId, email: member.rows[0].primary_email, displayName: member.rows[0].display_name, role, joinedAt: member.rows[0].joined_at.toISOString() };
    });
  }

  async removeWorkspaceMember(actor: AuthenticatedSession, workspaceId: string, accountId: string, correlationId: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      const member = await client.query<{ role_key: BuiltInRole }>(`SELECT r.role_key FROM workspace_memberships wm JOIN roles r ON r.id=wm.role_id WHERE wm.workspace_id=$1 AND wm.account_id=$2 FOR UPDATE`, [workspaceId, accountId]);
      if (!member.rowCount) return false;
      if (member.rows[0].role_key === "owner") throw new DomainError("owner_transfer_required", "Transfer or remove organisation ownership before removing this owner from the workspace.", 409);
      await client.query(`DELETE FROM workspace_memberships WHERE workspace_id=$1 AND account_id=$2`, [workspaceId, accountId]);
      await appendAudit(client, actor, workspaceId, "member.removed", "member", accountId, { role: member.rows[0].role_key }, null, correlationId);
      return true;
    });
  }

  async revokeInvitation(actor: AuthenticatedSession, workspaceId: string, invitationId: string, correlationId: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query(
        `UPDATE invitations invitation SET status='revoked',revoked_at=now()
          WHERE invitation.id=$1 AND invitation.status='pending' AND EXISTS(SELECT 1 FROM invitation_workspaces iw WHERE iw.invitation_id=invitation.id AND iw.workspace_id=$2)`,
        [invitationId, workspaceId]
      );
      if (!result.rowCount) return false;
      await appendAudit(client, actor, workspaceId, "member.invitation_revoked", "invitation", invitationId, null, { revoked: true }, correlationId);
      return true;
    });
  }

  async authenticateRunnerRequest(input: RunnerDeviceRequestInput): Promise<RunnerDeviceSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ account_id: string; workspace_id: string | null; status: string; public_key: Buffer }>(
        `SELECT r.account_id,r.workspace_id,r.status,k.public_key FROM runners r JOIN runner_device_keys k ON k.runner_id=r.id
          WHERE r.id=$1 AND k.key_id=$2 AND r.revoked_at IS NULL AND k.revoked_at IS NULL FOR UPDATE`, [input.runnerId, input.keyId]
      );
      if (!result.rowCount || !result.rows[0].workspace_id || result.rows[0].status === "revoked") throw new DomainError("runner_authentication_failed", "Runner identity is unknown, revoked, or not assigned to a workspace.", 401);
      if (!verifyRunnerRequestSignature({ runnerId: input.runnerId, keyId: input.keyId, requestTime: input.requestTime, nonce: input.nonce, method: input.method, path: input.path, body: input.body }, result.rows[0].public_key, input.signatureBase64)) throw new DomainError("runner_signature_invalid", "Runner request signature is invalid.", 401);
      if (!/^[A-Za-z0-9_-]{16,200}$/.test(input.nonce)) throw new DomainError("runner_nonce_invalid", "Runner request nonce is invalid.", 400);
      try {
        await client.query(`INSERT INTO runner_request_nonces(runner_id,nonce,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [input.runnerId, input.nonce]);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) throw new DomainError("runner_request_replayed", "Runner request nonce has already been used.", 409);
        throw error;
      }
      await client.query(`DELETE FROM runner_request_nonces WHERE expires_at < now()`);
      await client.query("COMMIT");
      return { runnerId: input.runnerId, accountId: result.rows[0].account_id, workspaceId: result.rows[0].workspace_id, keyId: input.keyId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordRunnerHeartbeat(device: RunnerDeviceSession, currentWorkload: number, status: "online" | "paused" | "draining" | "maintenance"): Promise<RunnerRecord> {
    return this.withAccount(device.accountId, async client => {
      const result = await client.query<RunnerRow>(
        `UPDATE runners SET current_workload=$1,status=$2,last_seen_at=now()
          WHERE id=$3 AND workspace_id=$4 AND revoked_at IS NULL
          RETURNING id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status,current_workload,paired_at,last_seen_at`,
        [currentWorkload, status, device.runnerId, device.workspaceId]
      );
      if (!result.rowCount) throw new DomainError("runner_revoked", "Runner is no longer active in this workspace.", 403);
      return runnerFromRow(result.rows[0]);
    });
  }

  async dequeueRunnerCommands(device: RunnerDeviceSession, limit: number): Promise<RunnerCommand[]> {
    return this.withAccount(device.accountId, async client => {
      await client.query(`UPDATE runner_commands SET status='expired' WHERE target_runner_id=$1 AND status IN ('queued','delivered','accepted') AND expires_at<=now()`, [device.runnerId]);
      const result = await client.query<RunnerCommandRow>(
        `SELECT id,issuer_account_id,workspace_id,target_runner_id,action,workflow_revision_id,convert_from(payload_ciphertext,'utf8')::jsonb AS payload,authorization_context,created_at,expires_at,idempotency_key,key_id,encode(signature,'base64') AS signature,status
           FROM runner_commands WHERE target_runner_id=$1 AND workspace_id=$2
            AND authorization_context IS NOT NULL AND (status='queued' OR (status IN ('delivered','accepted') AND delivered_at<=now()-interval '30 seconds')) AND expires_at>now()
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $3`, [device.runnerId, device.workspaceId, limit]
      );
      if (result.rowCount) await client.query(`UPDATE runner_commands SET status='delivered',delivered_at=now() WHERE id=ANY($1::uuid[])`, [result.rows.map(row => row.id)]);
      return result.rows.map(row => runnerCommandFromRow({ ...row, status: "delivered" }));
    });
  }

  async updateRunnerCommandStatus(device: RunnerDeviceSession, commandId: string, status: "accepted" | "rejected" | "completed", resultSummary: Record<string, unknown> | null): Promise<boolean> {
    return this.withAccount(device.accountId, async client => {
      const result = await client.query(
        `UPDATE runner_commands SET status=$1,result_summary=$2,completed_at=CASE WHEN $1 IN ('rejected','completed') THEN now() ELSE completed_at END
          WHERE id=$3 AND target_runner_id=$4 AND workspace_id=$5 AND expires_at>now() AND status IN ('delivered','accepted')`,
        [status, redact(resultSummary), commandId, device.runnerId, device.workspaceId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async recordRunnerTriggerEvents(device: RunnerDeviceSession, events: RunnerTriggerEventInput[]): Promise<{ acceptedEventIds: string[]; duplicateEventIds: string[] }> {
    return this.withAccount(device.accountId, async client => {
      const acceptedEventIds: string[] = [];
      const duplicateEventIds: string[] = [];
      for (const event of events) {
        const deployment = await client.query(
          `SELECT 1 FROM workflow_deployments
            WHERE id=$1 AND workspace_id=$2 AND workflow_revision_id=$3
              AND target_type='self_hosted_runner' AND target_runner_id=$4 AND status='active'`,
          [event.deploymentId, device.workspaceId, event.workflowRevisionId, device.runnerId]
        );
        if (!deployment.rowCount) throw new DomainError("trigger_event_lease_invalid", "The polling trigger is not leased to this runner for the active workflow revision.", 403);
        const inserted = await client.query(
          `INSERT INTO runner_trigger_events(id,workspace_id,deployment_id,workflow_revision_id,runner_id,node_id,plugin_id,plugin_version,dedupe_key,payload,provider_checkpoint,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT(deployment_id,node_id,dedupe_key) DO NOTHING RETURNING id`,
          [event.eventId, device.workspaceId, event.deploymentId, event.workflowRevisionId, device.runnerId, event.nodeId, event.pluginId, event.pluginVersion, event.dedupeKey, event.payload, event.providerCheckpoint, event.occurredAt]
        );
        (inserted.rowCount ? acceptedEventIds : duplicateEventIds).push(event.eventId);
      }
      return { acceptedEventIds, duplicateEventIds };
    });
  }

  async recordRunSummary(device: RunnerDeviceSession, summary: RunSummary): Promise<void> {
    await this.withAccount(device.accountId, async client => {
      const revision = await client.query(`SELECT 1 FROM workflow_revisions r JOIN synced_workflows w ON w.id=r.workflow_id WHERE r.id=$1 AND r.workflow_id=$2 AND w.workspace_id=$3`, [summary.revisionId, summary.workflowId, device.workspaceId]);
      if (!revision.rowCount) throw new DomainError("run_summary_revision_invalid", "Run summary references a workflow revision outside this workspace.", 403);
      await client.query(
        `INSERT INTO run_summaries(id,workspace_id,workflow_id,revision_id,runner_id,trigger,status,started_at,duration_ms,failed_node_id,redacted_error_summary)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
        [summary.id, device.workspaceId, summary.workflowId, summary.revisionId, device.runnerId, summary.trigger, summary.status, summary.startedAt, summary.durationMs, summary.failedNodeId, summary.redactedErrorSummary]
      );
    });
  }

  async listWorkspaceActivity(actor: AuthenticatedSession, workspaceId: string, limit: number): Promise<WorkspaceActivitySummary> {
    return this.withAccount(actor.accountId, async client => {
      const runners = await client.query<RunnerRow>(`SELECT id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status,current_workload,paired_at,last_seen_at FROM runners WHERE workspace_id=$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC NULLS LAST,id LIMIT 100`, [workspaceId]);
      const runs = await client.query<RunSummaryRow>(`SELECT id,workspace_id,workflow_id,revision_id,runner_id,trigger,status,started_at,duration_ms,failed_node_id,redacted_error_summary FROM run_summaries WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [workspaceId, limit]);
      const approvals = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM workflow_approvals WHERE workspace_id=$1 AND status='pending'`, [workspaceId]);
      const webhooks = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM webhook_deliveries WHERE workspace_id=$1 AND status='failed'`, [workspaceId]);
      const conflicts = await client.query<{ count: string }>(`SELECT count(DISTINCT revision.workflow_id)::text AS count FROM workflow_revisions revision JOIN synced_workflows workflow ON workflow.id=revision.workflow_id WHERE workflow.workspace_id=$1 AND revision.sync_state='conflicted'`, [workspaceId]);
      return { generatedAt: new Date().toISOString(), runners: runners.rows.map(runnerFromRow), runs: runs.rows.map(runSummaryFromRow), pendingApprovalCount: Number(approvals.rows[0]?.count ?? 0), webhookFailureCount: Number(webhooks.rows[0]?.count ?? 0), syncConflictCount: Number(conflicts.rows[0]?.count ?? 0) };
    });
  }

  async listDeployments(actor: AuthenticatedSession, workspaceId: string): Promise<DeploymentRecord[]> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{
        id:string;workspace_id:string;workflow_id:string;workflow_revision_id:string;environment_id:string;environment:string;target_type:DeploymentRecord["target"];
        target_runner_id:string|null;runner_pool_id:string|null;region:string;required_connection_ids:string[];required_plugins:DeploymentRecord["requiredPlugins"];
        permission_snapshot_id:string;status:DeploymentRecord["status"];validation_result:Record<string,unknown>;usage_estimate:DeploymentRecord["usageEstimate"];
        created_by:string;created_at:Date;activated_at:Date|null;supersedes_deployment_id:string|null;
      }>(
        `SELECT deployment.id,deployment.workspace_id,deployment.workflow_id,deployment.workflow_revision_id,
                deployment.environment_id,environment.environment_key AS environment,deployment.target_type,
                deployment.target_runner_id,deployment.runner_pool_id,deployment.region,deployment.required_connection_ids,
                deployment.required_plugins,deployment.permission_snapshot_id,deployment.status,deployment.validation_result,
                deployment.usage_estimate,deployment.created_by,deployment.created_at,deployment.activated_at,
                deployment.supersedes_deployment_id
           FROM workflow_deployments deployment
           JOIN environments environment ON environment.id=deployment.environment_id
          WHERE deployment.workspace_id=$1
          ORDER BY deployment.updated_at DESC,deployment.id
          LIMIT 500`,
        [workspaceId]
      );
      return result.rows.map(row=>({
        deploymentId:row.id,workspaceId:row.workspace_id,workflowId:row.workflow_id,workflowRevisionId:row.workflow_revision_id,
        environmentId:row.environment_id,environment:row.environment as DeploymentRecord["environment"],target:row.target_type,targetRunnerId:row.target_runner_id,
        runnerPoolId:row.runner_pool_id,region:row.region,requiredConnectionIds:row.required_connection_ids,requiredPlugins:row.required_plugins,
        permissionSnapshotId:row.permission_snapshot_id,status:row.status,validation:row.validation_result,usageEstimate:row.usage_estimate,
        createdBy:row.created_by,createdAt:row.created_at.toISOString(),activatedAt:row.activated_at?.toISOString()??null,supersedesDeploymentId:row.supersedes_deployment_id
      }));
    });
  }

  async createDeployment(actor:AuthenticatedSession,workspaceId:string,input:DeploymentCreationInput,correlationId:string):Promise<DeploymentRecord>{
    return this.withAccount(actor.accountId,async client=>{
      if(input.requirements.workspaceId!==workspaceId||input.requirements.environmentId!==input.environmentId)throw new DomainError("deployment_workspace_mismatch","Deployment routing requirements must match the selected workspace and environment.",400);
      if(input.requirements.region!==null&&input.requirements.region!==input.region)throw new DomainError("deployment_region_mismatch","Deployment region must match its runner requirements.",400);
      if(input.validation.valid!==true||Array.isArray(input.validation.issues)&&input.validation.issues.some(issue=>typeof issue==="object"&&issue!==null&&(issue as {severity?:unknown}).severity==="error"))throw new DomainError("deployment_validation_required","A successful deployment preflight is required.",409);
      const revision=await client.query<{environment:"development"|"staging"|"production";plugin_requirements:DeploymentRecord["requiredPlugins"];permission_snapshot_id:string;network_targets:string[]}>(
        `SELECT environment.environment_key AS environment,revision.plugin_requirements,snapshot.id AS permission_snapshot_id,snapshot.network_targets
           FROM synced_workflows workflow
           JOIN workflow_revisions revision ON revision.id=$3 AND revision.workflow_id=workflow.id
           JOIN environments environment ON environment.id=$4 AND environment.workspace_id=workflow.workspace_id
           JOIN LATERAL(SELECT id FROM workflow_permission_snapshots WHERE workflow_revision_id=revision.id AND content_hash=revision.content_hash AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1) snapshot ON true
          WHERE workflow.id=$2 AND workflow.workspace_id=$1 AND workflow.current_published_revision_id=revision.id`,
        [workspaceId,input.workflowId,input.workflowRevisionId,input.environmentId]
      );
      if(!revision.rowCount)throw new DomainError("deployment_revision_invalid","Deployment requires the current published revision, its environment, and an active permission snapshot.",409);
      if(!samePluginRequirements(revision.rows[0].plugin_requirements,input.requiredPlugins)||!samePluginRequirements(input.requirements.plugins,input.requiredPlugins))throw new DomainError("deployment_plugin_requirements_mismatch","Deployment plugins must exactly match the published revision and runner requirements.",409);
      if(!sameStringSet(revision.rows[0].network_targets,input.networkTargets))throw new DomainError("deployment_network_requirements_mismatch","Deployment network targets must exactly match the approved permission snapshot.",409);
      if(!sameStringSet(input.requirements.connectionIds,input.requiredConnectionIds))throw new DomainError("deployment_connection_requirements_mismatch","Deployment connections must exactly match runner requirements.",409);
      if(input.requiredConnectionIds.length){const connections=await client.query<{count:string}>(`SELECT count(DISTINCT id)::text AS count FROM shared_connections WHERE workspace_id=$1 AND environment_id=$2 AND id=ANY($3::uuid[]) AND health='available' AND (cardinality(permitted_workflow_ids)=0 OR $4=ANY(permitted_workflow_ids))`,[workspaceId,input.environmentId,input.requiredConnectionIds,input.workflowId]);if(Number(connections.rows[0]?.count??0)!==new Set(input.requiredConnectionIds).size)throw new DomainError("deployment_connection_unavailable","Every required connection must be available in the selected environment and permit this workflow.",409);}
      if(input.protectedVariableNames.length){const variables=await client.query<{count:string}>(`SELECT count(DISTINCT name)::text AS count FROM protected_variables WHERE environment_id=$1 AND name=ANY($2::text[]) AND $3=ANY(allowed_workflow_ids)`,[input.environmentId,input.protectedVariableNames,input.workflowId]);if(Number(variables.rows[0]?.count??0)!==new Set(input.protectedVariableNames).size)throw new DomainError("deployment_variable_unavailable","Every protected variable must exist in the selected environment and permit this workflow.",409);}
      const directTargets=new Set<DeploymentRecord["target"]>(["this_computer","paired_desktop","self_hosted_server","nas_or_raspberry_pi"]);
      if(input.target==="runner_pool"){
        if(!input.runnerPoolId||input.targetRunnerId)throw new DomainError("deployment_target_invalid","Runner-pool deployments require only a runner pool.",400);
        const pool=await client.query(`SELECT 1 FROM runner_pools WHERE id=$1 AND workspace_id=$2 AND environment_id=$3 AND status='active'`,[input.runnerPoolId,workspaceId,input.environmentId]);if(!pool.rowCount)throw new DomainError("deployment_runner_pool_unavailable","Runner pool is missing, paused, or outside the selected environment.",409);
        if(input.requiredConnectionIds.length){const eligible=await client.query(`SELECT 1 FROM runner_pool_members member JOIN runners runner ON runner.id=member.runner_id WHERE member.pool_id=$1 AND member.enabled AND runner.status='online' AND runner.revoked_at IS NULL AND (SELECT count(DISTINCT deployment.connection_id) FROM shared_connection_runner_deployments deployment WHERE deployment.runner_id=runner.id AND deployment.connection_id=ANY($2::uuid[]) AND deployment.status='available')=$3 LIMIT 1`,[input.runnerPoolId,input.requiredConnectionIds,new Set(input.requiredConnectionIds).size]);if(!eligible.rowCount)throw new DomainError("deployment_runner_pool_connections_unavailable","No online runner in the pool has every required connection.",409);}
      }else if(directTargets.has(input.target)){
        if(!input.targetRunnerId||input.runnerPoolId)throw new DomainError("deployment_target_invalid","This deployment target requires one paired runner.",400);
        const runner=await client.query(`SELECT 1 FROM runners WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND status='online'`,[input.targetRunnerId,workspaceId]);if(!runner.rowCount)throw new DomainError("deployment_runner_unavailable","Target runner is unavailable in this workspace.",409);
        if(input.requiredConnectionIds.length){const runnerConnections=await client.query<{count:string}>(`SELECT count(DISTINCT connection_id)::text AS count FROM shared_connection_runner_deployments WHERE runner_id=$1 AND connection_id=ANY($2::uuid[]) AND status='available'`,[input.targetRunnerId,input.requiredConnectionIds]);if(Number(runnerConnections.rows[0]?.count??0)!==new Set(input.requiredConnectionIds).size)throw new DomainError("deployment_runner_connection_unavailable","Target runner does not have every required connection.",409);}
      }else if(input.targetRunnerId||input.runnerPoolId)throw new DomainError("deployment_target_invalid","Managed targets cannot reference a paired runner or runner pool.",400);
      if(input.supersedesDeploymentId){const previous=await client.query(`SELECT 1 FROM workflow_deployments WHERE id=$1 AND workspace_id=$2 AND workflow_id=$3 AND environment_id=$4 AND status IN ('active','degraded','paused')`,[input.supersedesDeploymentId,workspaceId,input.workflowId,input.environmentId]);if(!previous.rowCount)throw new DomainError("deployment_supersedes_invalid","Only an active deployment of the same workflow and environment can be superseded.",409);}
      const deploymentId=randomUUID(),now=new Date(),permissionSnapshotId=revision.rows[0].permission_snapshot_id;
      const persistedValidation={...input.validation,requirements:input.requirements};
      await client.query(`INSERT INTO workflow_deployments(id,workspace_id,workflow_id,workflow_revision_id,environment_id,target_type,target_runner_id,runner_pool_id,region,status,required_connection_ids,required_plugins,required_capabilities,protected_variable_names,connection_mappings,protected_variable_mappings,permission_snapshot_id,validation_result,usage_estimate,retention_policy,concurrency_policy,supersedes_deployment_id,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,[deploymentId,workspaceId,input.workflowId,input.workflowRevisionId,input.environmentId,input.target,input.targetRunnerId,input.runnerPoolId,input.region,input.requiredConnectionIds,JSON.stringify(input.requiredPlugins),JSON.stringify(input.requiredCapabilities),input.protectedVariableNames,JSON.stringify(Object.fromEntries(input.requiredConnectionIds.map(id=>[id,id]))),JSON.stringify(Object.fromEntries(input.protectedVariableNames.map(name=>[name,name]))),permissionSnapshotId,JSON.stringify(persistedValidation),JSON.stringify(input.usageEstimate),JSON.stringify({executionDetailDays:input.retentionDays}),JSON.stringify({maximumConcurrency:input.concurrencyLimit}),input.supersedesDeploymentId,actor.accountId,now]);
      for(const [from,to,version,reason] of [["draft","validating",0,"Server-side validation started"],["validating","deploying",1,"All deployment resources validated"],["deploying","active",2,"Deployment activated"]] as const)await client.query(`INSERT INTO deployment_events(id,deployment_id,sequence,from_status,to_status,expected_version,actor_id,reason,metadata,occurred_at,correlation_id) VALUES($1,$2,0,$3,$4,$5,$6,$7,'{}',$8,$9)`,[randomUUID(),deploymentId,from,to,version,actor.accountId,reason,now,correlationId]);
      if(input.supersedesDeploymentId){const previous=await client.query<{status:DeploymentRecord["status"];status_version:number}>(`SELECT status,status_version FROM workflow_deployments WHERE id=$1 FOR UPDATE`,[input.supersedesDeploymentId]);await client.query(`INSERT INTO deployment_events(id,deployment_id,sequence,from_status,to_status,expected_version,actor_id,reason,metadata,occurred_at,correlation_id) VALUES($1,$2,0,$3,'superseded',$4,$5,'Replacement deployment activated',$6,$7,$8)`,[randomUUID(),input.supersedesDeploymentId,previous.rows[0].status,previous.rows[0].status_version,actor.accountId,JSON.stringify({replacementDeploymentId:deploymentId}),now,correlationId]);}
      await appendAudit(client,actor,workspaceId,"deployment.created","workflow_deployment",deploymentId,null,{workflowId:input.workflowId,workflowRevisionId:input.workflowRevisionId,environmentId:input.environmentId,target:input.target,runnerPoolId:input.runnerPoolId,targetRunnerId:input.targetRunnerId},correlationId);
      return{deploymentId,workspaceId,workflowId:input.workflowId,workflowRevisionId:input.workflowRevisionId,environmentId:input.environmentId,environment:revision.rows[0].environment,target:input.target,targetRunnerId:input.targetRunnerId,runnerPoolId:input.runnerPoolId,region:input.region,requiredConnectionIds:input.requiredConnectionIds,requiredPlugins:input.requiredPlugins,permissionSnapshotId,status:"active",validation:persistedValidation,usageEstimate:input.usageEstimate,createdBy:actor.accountId,createdAt:now.toISOString(),activatedAt:now.toISOString(),supersedesDeploymentId:input.supersedesDeploymentId};
    });
  }

  async transitionDeployment(actor:AuthenticatedSession,workspaceId:string,deploymentId:string,status:DeploymentRecord["status"],reason:string,correlationId:string){
    return this.withAccount(actor.accountId,async client=>{const current=await client.query<{status:DeploymentRecord["status"];status_version:number}>(`SELECT status,status_version FROM workflow_deployments WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,[deploymentId,workspaceId]);if(!current.rowCount)return null;requireDeploymentTransition(current.rows[0].status,status);await client.query(`INSERT INTO deployment_events(id,deployment_id,sequence,from_status,to_status,expected_version,actor_id,reason,metadata,occurred_at,correlation_id) VALUES($1,$2,0,$3,$4,$5,$6,$7,'{}',now(),$8)`,[randomUUID(),deploymentId,current.rows[0].status,status,current.rows[0].status_version,actor.accountId,reason,correlationId]);await appendAudit(client,actor,workspaceId,"deployment.status_changed","workflow_deployment",deploymentId,{status:current.rows[0].status},{status,reason},correlationId);return{deploymentId,status};});
  }

  async listRunnerPools(actor: AuthenticatedSession, workspaceId: string) {
    return this.withAccount(actor.accountId, async client => {
      const result=await client.query<{
        id:string;workspace_id:string;environment_id:string;name:string;strategy:"least_loaded"|"round_robin"|"priority_failover";region:string|null;required_tags:string[];maximum_concurrency:number;status:"active"|"paused"|"draining";member_count:string;created_at:Date;updated_at:Date;
      }>(
        `SELECT pool.id,pool.workspace_id,pool.environment_id,pool.name,pool.strategy,pool.region,
                pool.required_tags,pool.maximum_concurrency,pool.status,count(member.runner_id)::text AS member_count,
                pool.created_at,pool.updated_at
           FROM runner_pools pool LEFT JOIN runner_pool_members member ON member.pool_id=pool.id AND member.enabled
          WHERE pool.workspace_id=$1
          GROUP BY pool.id ORDER BY pool.name,pool.id`,
        [workspaceId]
      );
      return result.rows.map(row=>({id:row.id,workspaceId:row.workspace_id,environmentId:row.environment_id,name:row.name,strategy:row.strategy,region:row.region,requiredTags:row.required_tags,maximumConcurrency:row.maximum_concurrency,status:row.status,memberCount:Number(row.member_count),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}));
    });
  }

  async createRunnerPool(actor:AuthenticatedSession,workspaceId:string,input:RunnerPoolInput,correlationId:string):Promise<RunnerPoolRecord>{
    return this.withAccount(actor.accountId,async client=>{
      await validateRunnerPoolReferences(client,workspaceId,input);
      const poolId=randomUUID();
      await client.query(`INSERT INTO runner_pools(id,workspace_id,environment_id,name,strategy,region,required_tags,maximum_concurrency,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[poolId,workspaceId,input.environmentId,input.name,input.strategy,input.region,input.requiredTags,input.maximumConcurrency,input.status,actor.accountId]);
      await replaceRunnerPoolMembers(client,poolId,input.members);
      await appendAudit(client,actor,workspaceId,"runner_pool.created","runner_pool",poolId,null,{name:input.name,environmentId:input.environmentId,strategy:input.strategy,memberCount:input.members.length},correlationId);
      return readRunnerPool(client,workspaceId,poolId);
    });
  }

  async updateRunnerPool(actor:AuthenticatedSession,workspaceId:string,poolId:string,input:RunnerPoolInput,correlationId:string):Promise<RunnerPoolRecord|null>{
    return this.withAccount(actor.accountId,async client=>{
      await validateRunnerPoolReferences(client,workspaceId,input);
      const updated=await client.query(`UPDATE runner_pools SET environment_id=$1,name=$2,strategy=$3,region=$4,required_tags=$5,maximum_concurrency=$6,status=$7,updated_at=now() WHERE id=$8 AND workspace_id=$9`,[input.environmentId,input.name,input.strategy,input.region,input.requiredTags,input.maximumConcurrency,input.status,poolId,workspaceId]);
      if(!updated.rowCount)return null;
      await replaceRunnerPoolMembers(client,poolId,input.members);
      await appendAudit(client,actor,workspaceId,"runner_pool.updated","runner_pool",poolId,null,{name:input.name,environmentId:input.environmentId,strategy:input.strategy,status:input.status,memberCount:input.members.length},correlationId);
      return readRunnerPool(client,workspaceId,poolId);
    });
  }

  async deleteRunnerPool(actor:AuthenticatedSession,workspaceId:string,poolId:string,correlationId:string):Promise<boolean>{
    return this.withAccount(actor.accountId,async client=>{
      const active=await client.query(`SELECT 1 FROM workflow_deployments WHERE runner_pool_id=$1 AND status IN ('active','degraded','paused','deploying') LIMIT 1`,[poolId]);
      if(active.rowCount)throw new DomainError("runner_pool_in_use","Pause or supersede active deployments before deleting this runner pool.",409);
      const deleted=await client.query(`DELETE FROM runner_pools WHERE id=$1 AND workspace_id=$2`,[poolId,workspaceId]);
      if(deleted.rowCount)await appendAudit(client,actor,workspaceId,"runner_pool.deleted","runner_pool",poolId,null,{},correlationId);
      return Boolean(deleted.rowCount);
    });
  }

  async listOrganisationRoles(actor:AuthenticatedSession,organisationId:string):Promise<OrganisationRoleRecord[]>{
    return this.withAccount(actor.accountId,async client=>{
      const result=await client.query<{id:string;organisation_id:string;role_key:string;display_name:string;built_in:boolean;permissions:Permission[]}>(`SELECT role.id,role.organisation_id,role.role_key,role.display_name,role.built_in,COALESCE(array_agg(permission.permission ORDER BY permission.permission) FILTER(WHERE permission.permission IS NOT NULL),'{}') AS permissions FROM roles role LEFT JOIN role_permissions permission ON permission.role_id=role.id WHERE role.organisation_id=$1 GROUP BY role.id ORDER BY role.built_in DESC,role.display_name`,[organisationId]);
      return result.rows.map(row=>({id:row.id,organisationId:row.organisation_id,key:row.role_key,displayName:row.display_name,builtIn:row.built_in,permissions:row.permissions.filter(permission=>allPermissions.includes(permission))}));
    });
  }

  async createOrganisationRole(actor:AuthenticatedSession,organisationId:string,key:string,displayName:string,rolePermissions:Permission[],correlationId:string):Promise<OrganisationRoleRecord>{
    return this.withAccount(actor.accountId,async client=>{
      const role=await client.query<{id:string}>(`INSERT INTO roles(organisation_id,role_key,display_name,built_in) VALUES($1,$2,$3,false) RETURNING id`,[organisationId,key,displayName]);
      for(const permission of [...new Set(rolePermissions)])await client.query(`INSERT INTO role_permissions(role_id,permission) VALUES($1,$2)`,[role.rows[0].id,permission]);
      await appendOrganisationAudit(client,actor,organisationId,"role.created",role.rows[0].id,{key,displayName,permissions:rolePermissions},correlationId);
      return {id:role.rows[0].id,organisationId,key,displayName,builtIn:false,permissions:[...new Set(rolePermissions)].sort()};
    });
  }

  async updateOrganisationRole(actor:AuthenticatedSession,organisationId:string,roleId:string,displayName:string,rolePermissions:Permission[],correlationId:string):Promise<OrganisationRoleRecord|null>{
    return this.withAccount(actor.accountId,async client=>{
      const role=await client.query<{role_key:string}>(`UPDATE roles SET display_name=$1 WHERE id=$2 AND organisation_id=$3 AND NOT built_in RETURNING role_key`,[displayName,roleId,organisationId]);
      if(!role.rowCount)return null;
      await client.query(`DELETE FROM role_permissions WHERE role_id=$1`,[roleId]);
      for(const permission of [...new Set(rolePermissions)])await client.query(`INSERT INTO role_permissions(role_id,permission) VALUES($1,$2)`,[roleId,permission]);
      await appendOrganisationAudit(client,actor,organisationId,"role.updated",roleId,{displayName,permissions:rolePermissions},correlationId);
      return {id:roleId,organisationId,key:role.rows[0].role_key,displayName,builtIn:false,permissions:[...new Set(rolePermissions)].sort()};
    });
  }

  async deleteOrganisationRole(actor:AuthenticatedSession,organisationId:string,roleId:string,correlationId:string):Promise<boolean>{
    return this.withAccount(actor.accountId,async client=>{
      const assigned=await client.query(`SELECT 1 FROM memberships WHERE role_id=$1 UNION ALL SELECT 1 FROM workspace_memberships WHERE role_id=$1 LIMIT 1`,[roleId]);
      if(assigned.rowCount)throw new DomainError("role_in_use","Move every member off this role before deleting it.",409);
      const deleted=await client.query(`DELETE FROM roles WHERE id=$1 AND organisation_id=$2 AND NOT built_in`,[roleId,organisationId]);
      if(deleted.rowCount)await appendOrganisationAudit(client,actor,organisationId,"role.deleted",roleId,{},correlationId);
      return Boolean(deleted.rowCount);
    });
  }

  async listSsoConnections(actor:AuthenticatedSession,organisationId:string):Promise<SsoConnectionRecord[]>{
    return this.withAccount(actor.accountId,async client=>{
      const result=await client.query<SsoConnectionRow>(`SELECT id,organisation_id,connection_type,display_name,issuer_url,client_identifier,verified_domains,enabled,created_at,updated_at FROM organisation_sso_connections WHERE organisation_id=$1 ORDER BY display_name,id`,[organisationId]);
      return result.rows.map(ssoConnectionFromRow);
    });
  }

  async createSsoConnection(actor:AuthenticatedSession,organisationId:string,input:SsoConnectionInput,correlationId:string):Promise<SsoConnectionRecord>{
    return this.withAccount(actor.accountId,async client=>{
      const id=randomUUID(),result=await client.query<SsoConnectionRow>(`INSERT INTO organisation_sso_connections(id,organisation_id,connection_type,display_name,issuer_url,client_identifier,verified_domains,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,organisation_id,connection_type,display_name,issuer_url,client_identifier,verified_domains,enabled,created_at,updated_at`,[id,organisationId,input.connectionType,input.displayName,input.issuerUrl,input.clientIdentifier,input.verifiedDomains,input.enabled,actor.accountId]);
      await appendOrganisationAudit(client,actor,organisationId,"sso_connection.created",id,{connectionType:input.connectionType,displayName:input.displayName,verifiedDomains:input.verifiedDomains,enabled:input.enabled},correlationId);
      return ssoConnectionFromRow(result.rows[0]);
    });
  }

  async updateSsoConnection(actor:AuthenticatedSession,organisationId:string,connectionId:string,input:SsoConnectionInput,correlationId:string):Promise<SsoConnectionRecord|null>{
    return this.withAccount(actor.accountId,async client=>{
      const result=await client.query<SsoConnectionRow>(`UPDATE organisation_sso_connections SET connection_type=$1,display_name=$2,issuer_url=$3,client_identifier=$4,verified_domains=$5,enabled=$6,updated_at=now() WHERE id=$7 AND organisation_id=$8 RETURNING id,organisation_id,connection_type,display_name,issuer_url,client_identifier,verified_domains,enabled,created_at,updated_at`,[input.connectionType,input.displayName,input.issuerUrl,input.clientIdentifier,input.verifiedDomains,input.enabled,connectionId,organisationId]);
      if(!result.rowCount)return null;
      await appendOrganisationAudit(client,actor,organisationId,"sso_connection.updated",connectionId,{connectionType:input.connectionType,displayName:input.displayName,verifiedDomains:input.verifiedDomains,enabled:input.enabled},correlationId);
      return ssoConnectionFromRow(result.rows[0]);
    });
  }

  async deleteSsoConnection(actor:AuthenticatedSession,organisationId:string,connectionId:string,correlationId:string):Promise<boolean>{
    return this.withAccount(actor.accountId,async client=>{const deleted=await client.query(`DELETE FROM organisation_sso_connections WHERE id=$1 AND organisation_id=$2`,[connectionId,organisationId]);if(deleted.rowCount)await appendOrganisationAudit(client,actor,organisationId,"sso_connection.deleted",connectionId,{},correlationId);return Boolean(deleted.rowCount);});
  }

  async listScimTokens(actor:AuthenticatedSession,organisationId:string):Promise<ScimTokenSummary[]>{
    return this.withAccount(actor.accountId,async client=>{const result=await client.query<ScimTokenRow>(`SELECT id,organisation_id,name,prefix,created_at,expires_at,last_used_at,revoked_at FROM organisation_scim_tokens WHERE organisation_id=$1 ORDER BY created_at DESC`,[organisationId]);return result.rows.map(scimTokenFromRow);});
  }

  async createScimToken(actor:AuthenticatedSession,organisationId:string,name:string,prefix:string,tokenHash:Buffer,expiresAt:Date,correlationId:string):Promise<ScimTokenSummary>{
    return this.withAccount(actor.accountId,async client=>{const id=randomUUID(),result=await client.query<ScimTokenRow>(`INSERT INTO organisation_scim_tokens(id,organisation_id,name,prefix,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,organisation_id,name,prefix,created_at,expires_at,last_used_at,revoked_at`,[id,organisationId,name,prefix,tokenHash,actor.accountId,expiresAt]);await appendOrganisationAudit(client,actor,organisationId,"scim_token.created",id,{name,prefix,expiresAt:expiresAt.toISOString()},correlationId);return scimTokenFromRow(result.rows[0]);});
  }

  async revokeScimToken(actor:AuthenticatedSession,organisationId:string,tokenId:string,correlationId:string):Promise<boolean>{
    return this.withAccount(actor.accountId,async client=>{const revoked=await client.query(`UPDATE organisation_scim_tokens SET revoked_at=now() WHERE id=$1 AND organisation_id=$2 AND revoked_at IS NULL`,[tokenId,organisationId]);if(revoked.rowCount)await appendOrganisationAudit(client,actor,organisationId,"scim_token.revoked",tokenId,{},correlationId);return Boolean(revoked.rowCount);});
  }

  async authenticateScimToken(tokenHash:Buffer){
    const result=await this.pool.query<{id:string;organisation_id:string;created_by:string}>(`UPDATE organisation_scim_tokens SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING id,organisation_id,created_by`,[tokenHash]);
    return result.rowCount?{organisationId:result.rows[0].organisation_id,tokenId:result.rows[0].id,provisioningAccountId:result.rows[0].created_by}:null;
  }

  async listScimUsers(organisationId:string,provisioningAccountId:string,startIndex:number,count:number,userNameFilter:string|null){
    return this.withScim(organisationId,provisioningAccountId,async client=>{
      const where=userNameFilter?"AND lower(user_name)=lower($2)":"";
      const filterValues=userNameFilter?[organisationId,userNameFilter]:[organisationId];
      const total=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM scim_managed_users WHERE organisation_id=$1 ${where}`,filterValues);
      const itemWhere=userNameFilter?"AND lower(user_name)=lower($4)":"";
      const values=userNameFilter?[organisationId,count,startIndex-1,userNameFilter]:[organisationId,count,startIndex-1];
      const result=await client.query<ScimUserRow>(`SELECT id,organisation_id,account_id,external_id,user_name,display_name,active,role_key,workspace_ids,created_at,updated_at FROM scim_managed_users WHERE organisation_id=$1 ${itemWhere} ORDER BY user_name,id LIMIT $2 OFFSET $3`,values);
      return{items:result.rows.map(scimUserFromRow),total:Number(total.rows[0]?.count??0)};
    });
  }

  async getScimUser(organisationId:string,provisioningAccountId:string,userId:string){
    return this.withScim(organisationId,provisioningAccountId,async client=>{const result=await client.query<ScimUserRow>(`SELECT id,organisation_id,account_id,external_id,user_name,display_name,active,role_key,workspace_ids,created_at,updated_at FROM scim_managed_users WHERE organisation_id=$1 AND id=$2`,[organisationId,userId]);return result.rowCount?scimUserFromRow(result.rows[0]):null;});
  }

  async upsertScimUser(organisationId:string,provisioningAccountId:string,userId:string|null,input:ScimManagedUserInput):Promise<ScimManagedUserRecord>{
    return this.withScim(organisationId,provisioningAccountId,async client=>{
      const role=await client.query<{id:string}>(`SELECT id FROM roles WHERE organisation_id=$1 AND role_key=$2`,[organisationId,input.role]);if(!role.rowCount)throw new DomainError("scim_role_invalid","SCIM role does not exist in this organisation.",400);
      const workspaces=await client.query<{id:string}>(`SELECT id FROM workspaces WHERE organisation_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,[organisationId,input.workspaceIds]);if(workspaces.rowCount!==new Set(input.workspaceIds).size)throw new DomainError("scim_workspace_invalid","Every SCIM workspace must belong to this organisation.",400);
      const existing=userId?await client.query<ScimUserRow>(`SELECT * FROM scim_managed_users WHERE organisation_id=$1 AND id=$2 FOR UPDATE`,[organisationId,userId]):await client.query<ScimUserRow>(`SELECT * FROM scim_managed_users WHERE organisation_id=$1 AND external_id=$2 FOR UPDATE`,[organisationId,input.externalId]);
      if(userId&&!existing.rowCount)throw new DomainError("scim_user_not_found","SCIM user was not found.",404);
      let accountId=existing.rows[0]?.account_id;
      if(!accountId){const account=await client.query<{id:string;identity_subject:string}>(`SELECT id,identity_subject FROM accounts WHERE lower(primary_email)=lower($1) AND deleted_at IS NULL`,[input.userName]);if(account.rowCount)accountId=account.rows[0].id;else{const created=await client.query<{id:string}>(`INSERT INTO accounts(identity_subject,primary_email,email_verified,display_name) VALUES($1,lower($2),true,$3) RETURNING id`,[`scim|${organisationId}|${input.externalId}`,input.userName,input.displayName]);accountId=created.rows[0].id;}}
      await client.query(`UPDATE accounts SET primary_email=lower($1),display_name=$2 WHERE id=$3 AND identity_subject LIKE $4`,[input.userName,input.displayName,accountId,`scim|${organisationId}|%`]);
      await client.query(`INSERT INTO memberships(organisation_id,account_id,role_id,status) VALUES($1,$2,$3,$4) ON CONFLICT(organisation_id,account_id) DO UPDATE SET role_id=excluded.role_id,status=excluded.status,removed_at=CASE WHEN excluded.status='active' THEN NULL ELSE now() END`,[organisationId,accountId,role.rows[0].id,input.active?"active":"suspended"]);
      await client.query(`DELETE FROM workspace_memberships membership USING workspaces workspace WHERE membership.workspace_id=workspace.id AND workspace.organisation_id=$1 AND membership.account_id=$2`,[organisationId,accountId]);
      if(input.active)for(const workspaceId of input.workspaceIds)await client.query(`INSERT INTO workspace_memberships(workspace_id,account_id,role_id) VALUES($1,$2,$3)`,[workspaceId,accountId,role.rows[0].id]);
      const id=existing.rows[0]?.id??randomUUID();
      const result=await client.query<ScimUserRow>(`INSERT INTO scim_managed_users(id,organisation_id,external_id,account_id,user_name,display_name,active,role_key,workspace_ids) VALUES($1,$2,$3,$4,lower($5),$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,user_name=excluded.user_name,display_name=excluded.display_name,active=excluded.active,role_key=excluded.role_key,workspace_ids=excluded.workspace_ids,updated_at=now() RETURNING id,organisation_id,account_id,external_id,user_name,display_name,active,role_key,workspace_ids,created_at,updated_at`,[id,organisationId,input.externalId,accountId,input.userName,input.displayName,input.active,input.role,input.workspaceIds]);
      return scimUserFromRow(result.rows[0]);
    });
  }

  async listWorkspaceEnvironments(actor: AuthenticatedSession, workspaceId: string) {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<{ id: string; environment_key: "development" | "staging" | "production" }>(`SELECT id,environment_key FROM environments WHERE workspace_id=$1 ORDER BY CASE environment_key WHEN 'development' THEN 0 WHEN 'staging' THEN 1 ELSE 2 END`, [workspaceId]);
      return result.rows.map(row => ({ environmentId: row.id, environment: row.environment_key }));
    });
  }

  async listSharedConnections(actor: AuthenticatedSession, workspaceId: string, environmentId: string | null): Promise<SharedConnectionRecord[]> {
    return this.withAccount(actor.accountId, async client => {
      const values: unknown[] = [workspaceId];
      const environmentClause = environmentId ? "AND c.environment_id=$2" : "";
      if (environmentId) values.push(environmentId);
      const result = await client.query<SharedConnectionRow>(
        `SELECT c.id,c.workspace_id,c.environment_id,c.provider,c.display_name,c.account_identity,c.granted_scopes,c.permitted_workflow_ids,c.permitted_role_ids,c.health,c.expires_at,c.last_used_at,c.created_by,c.approval_requirements
           FROM shared_connections c WHERE c.workspace_id=$1 ${environmentClause} ORDER BY c.display_name,c.id`, values
      );
      return result.rows.map(sharedConnectionFromRow);
    });
  }

  async createSharedConnection(actor: AuthenticatedSession, workspaceId: string, input: Omit<SharedConnectionRecord, "id" | "workspaceId" | "health" | "expiresAt" | "lastUsedAt" | "createdBy">, correlationId: string): Promise<SharedConnectionRecord> {
    return this.withAccount(actor.accountId, async client => {
      const environment = await client.query(`SELECT 1 FROM environments WHERE id=$1 AND workspace_id=$2`, [input.environmentId, workspaceId]);
      if (!environment.rowCount) throw new DomainError("environment_not_found", "Environment does not belong to this workspace.", 404);
      if (input.permittedWorkflowIds.length) {
        const workflows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM synced_workflows WHERE workspace_id=$1 AND id=ANY($2::uuid[])`, [workspaceId, input.permittedWorkflowIds]);
        if (Number(workflows.rows[0]?.count ?? 0) !== new Set(input.permittedWorkflowIds).size) throw new DomainError("connection_workflow_scope_invalid", "Every permitted workflow must belong to this workspace.", 400);
      }
      if (input.permittedRoleIds.length) {
        const roles = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM roles r JOIN workspaces w ON w.organisation_id=r.organisation_id WHERE w.id=$1 AND r.id=ANY($2::uuid[])`, [workspaceId, input.permittedRoleIds]);
        if (Number(roles.rows[0]?.count ?? 0) !== new Set(input.permittedRoleIds).size) throw new DomainError("connection_role_scope_invalid", "Every permitted role must belong to this workspace organisation.", 400);
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO shared_connections(id,workspace_id,environment_id,provider,display_name,account_identity,granted_scopes,permitted_workflow_ids,permitted_role_ids,health,created_by,approval_requirements)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorization_required',$10,$11)`,
        [id, workspaceId, input.environmentId, input.provider, input.displayName, input.accountIdentity, input.grantedScopes, input.permittedWorkflowIds, input.permittedRoleIds, actor.accountId, input.approvalRequirements]
      );
      await appendAudit(client, actor, workspaceId, "connection.created", "shared_connection", id, null, { provider: input.provider, displayName: input.displayName, environmentId: input.environmentId, grantedScopes: input.grantedScopes }, correlationId);
      return { id, workspaceId, ...input, health: "authorization_required", expiresAt: null, lastUsedAt: null, createdBy: actor.accountId };
    });
  }

  async deploySharedConnection(actor: AuthenticatedSession, workspaceId: string, connectionId: string, runnerId: string, status: "authorization_required" | "available" | "unavailable", localCredentialLabel: string | null, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      if (status === "available" && !localCredentialLabel) throw new DomainError("connection_credential_label_required", "An available deployment must identify the runner-local credential by a safe label.", 400);
      const scope = await client.query(`SELECT 1 FROM shared_connections c JOIN runners r ON r.workspace_id=c.workspace_id WHERE c.id=$1 AND c.workspace_id=$2 AND r.id=$3 AND r.revoked_at IS NULL`, [connectionId, workspaceId, runnerId]);
      if (!scope.rowCount) throw new DomainError("connection_deployment_scope_invalid", "Connection and runner must both belong to this workspace.", 404);
      await client.query(
        `INSERT INTO shared_connection_runner_deployments(connection_id,runner_id,status,local_credential_label,changed_by,changed_at) VALUES($1,$2,$3,$4,$5,now())
         ON CONFLICT(connection_id,runner_id) DO UPDATE SET status=excluded.status,local_credential_label=excluded.local_credential_label,changed_by=excluded.changed_by,changed_at=excluded.changed_at`,
        [connectionId, runnerId, status, localCredentialLabel, actor.accountId]
      );
      await client.query(`UPDATE shared_connections SET health=CASE WHEN EXISTS(SELECT 1 FROM shared_connection_runner_deployments WHERE connection_id=$1 AND status='available') THEN 'available' ELSE 'authorization_required' END WHERE id=$1`, [connectionId]);
      await appendAudit(client, actor, workspaceId, "connection.assigned", "shared_connection", connectionId, null, { runnerId, status, localCredentialLabel }, correlationId);
      return { connectionId, runnerId, status, localCredentialLabel };
    });
  }

  async getPluginBillingPlan(actor: AuthenticatedSession, ownerType: "personal" | "workspace", ownerId: string, pluginId: string, planId: string) {
    return this.withAccount(actor.accountId, async client => {
      let customerId: string | null = null;
      if (ownerType === "personal") {
        if (ownerId !== actor.accountId) throw new DomainError("billing_owner_invalid", "Personal billing owner does not match the authenticated account.", 403);
        const account = await client.query<{ billing_customer_ref: string | null }>(`SELECT billing_customer_ref FROM accounts WHERE id=$1`, [ownerId]);
        customerId = account.rows[0]?.billing_customer_ref ?? null;
      } else {
        const workspace = await client.query<{ billing_customer_ref: string | null }>(`SELECT o.billing_customer_ref FROM workspaces w JOIN organisations o ON o.id=w.organisation_id JOIN workspace_memberships wm ON wm.workspace_id=w.id AND wm.account_id=$2 WHERE w.id=$1`, [ownerId, actor.accountId]);
        if (!workspace.rowCount) throw new DomainError("billing_owner_invalid", "Workspace is not accessible to the authenticated account.", 403);
        customerId = workspace.rows[0].billing_customer_ref;
      }
      const result = await client.query<{ pricing: { plans?: Array<{ id?: string; stripePriceId?: string; mode?: string; offlineGraceDays?: number; seatAllowance?: number | null }> } }>(
        `SELECT l.pricing FROM plugin_listings l JOIN plugin_versions pv ON pv.id=l.current_version_id JOIN plugin_reviews pr ON pr.plugin_version_id=pv.id
          WHERE l.plugin_id=$1 AND pr.status='published' AND pv.revoked_at IS NULL AND l.suspended_at IS NULL AND l.removed_at IS NULL`, [pluginId]
      );
      const plan = result.rows[0]?.pricing.plans?.find(candidate => candidate.id === planId);
      if (!plan?.stripePriceId || !matchesBillingMode(plan.mode)) return null;
      const offlineGraceDays = Number.isInteger(plan.offlineGraceDays) && Number(plan.offlineGraceDays) >= 1 && Number(plan.offlineGraceDays) <= 30 ? Number(plan.offlineGraceDays) : 7;
      const seatAllowance = Number.isInteger(plan.seatAllowance) && Number(plan.seatAllowance) > 0 ? Number(plan.seatAllowance) : null;
      return { pluginId, planId, stripePriceId: plan.stripePriceId, mode: plan.mode, offlineGraceDays, seatAllowance, customerId };
    });
  }

  async recordMarketplaceCheckout(actor: AuthenticatedSession, checkoutId: string, ownerType: "personal" | "workspace", ownerId: string, pluginId: string, planId: string, expiresAt: string): Promise<void> {
    await this.withAccount(actor.accountId, async client => {
      await client.query(`INSERT INTO marketplace_checkout_sessions(id,account_id,owner_type,owner_id,plugin_id,plan_id,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,'open',$7)`, [checkoutId, actor.accountId, ownerType, ownerId, pluginId, planId, expiresAt]);
    });
  }

  async applyBillingEvent(event: BillingEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(`INSERT INTO processed_billing_events(event_id,event_kind) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING`, [event.eventId, event.kind]);
      if (!claimed.rowCount) { await client.query("COMMIT"); return; }
      if (event.kind === "checkout_completed") {
        const checkout = await client.query<{ account_id: string; owner_type: "personal" | "workspace"; owner_id: string; plugin_id: string; plan_id: string; pricing: { plans?: Array<{ id?: string; offlineGraceDays?: number; seatAllowance?: number | null }> } }>(
          `SELECT c.account_id,c.owner_type,c.owner_id,c.plugin_id,c.plan_id,l.pricing FROM marketplace_checkout_sessions c JOIN plugin_listings l ON l.plugin_id=c.plugin_id WHERE c.id=$1 AND c.status='open' FOR UPDATE`, [event.checkoutId]
        );
        if (!checkout.rowCount) throw new DomainError("checkout_not_found", "Completed checkout was not initiated by sndbox or was already resolved.", 409);
        const row = checkout.rows[0];
        const plan = row.pricing.plans?.find(candidate => candidate.id === row.plan_id);
        const graceDays = Number.isInteger(plan?.offlineGraceDays) && Number(plan?.offlineGraceDays) >= 1 && Number(plan?.offlineGraceDays) <= 30 ? Number(plan?.offlineGraceDays) : 7;
        const seats = Number.isInteger(plan?.seatAllowance) && Number(plan?.seatAllowance) > 0 ? Number(plan?.seatAllowance) : null;
        await client.query(
          `INSERT INTO entitlements(owner_type,owner_id,plugin_id,plan_id,purchase_source,starts_at,status,seat_allowance,offline_grace_until,stripe_customer_ref,stripe_subscription_ref,stripe_payment_ref)
           VALUES($1,$2,$3,$4,'stripe',now(),'active',$5,now()+($6::text||' days')::interval,$7,$8,$9)`,
          [row.owner_type, row.owner_id, row.plugin_id, row.plan_id, seats, graceDays, event.customerId, event.subscriptionId, event.paymentId]
        );
        await client.query(`UPDATE marketplace_checkout_sessions SET status='completed' WHERE id=$1`, [event.checkoutId]);
        if (event.customerId) {
          if (row.owner_type === "personal") await client.query(`UPDATE accounts SET billing_customer_ref=COALESCE(billing_customer_ref,$1) WHERE id=$2`, [event.customerId, row.owner_id]);
          else await client.query(`UPDATE organisations o SET billing_customer_ref=COALESCE(o.billing_customer_ref,$1) FROM workspaces w WHERE w.organisation_id=o.id AND w.id=$2`, [event.customerId, row.owner_id]);
        }
      } else if (event.kind === "subscription_changed") {
        const status = stripeEntitlementStatus(event.status);
        await client.query(`UPDATE entitlements SET status=$1,renews_at=$2,offline_grace_until=CASE WHEN $1 IN ('active','trial','past_due') THEN GREATEST(offline_grace_until,now()+interval '7 days') ELSE offline_grace_until END WHERE stripe_subscription_ref=$3`, [status, event.renewsAt, event.subscriptionId]);
      } else {
        await client.query(`UPDATE entitlements SET status=CASE WHEN $1 THEN 'refunded' ELSE status END,refund_state=CASE WHEN $1 THEN 'refunded' ELSE 'none' END WHERE stripe_payment_ref=$2`, [event.refunded, event.paymentId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async getActiveEntitlement(actor: AuthenticatedSession, ownerType: "personal" | "workspace", ownerId: string, pluginId: string) {
    return this.withAccount(actor.accountId, async client => {
      if (ownerType === "personal" && ownerId !== actor.accountId) throw new DomainError("entitlement_owner_invalid", "Personal entitlement is not owned by this account.", 403);
      if (ownerType === "workspace") {
        const member = await client.query(`SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND account_id=$2`, [ownerId, actor.accountId]);
        if (!member.rowCount) throw new DomainError("entitlement_owner_invalid", "Workspace entitlement is not accessible to this account.", 403);
      }
      const result = await client.query<{ id: string; plan_id: string; status: "trial" | "active" | "past_due"; seat_allowance: number | null; starts_at: Date; renews_at: Date | null; offline_grace_until: Date }>(
        `SELECT id,plan_id,status,seat_allowance,starts_at,renews_at,offline_grace_until FROM entitlements
          WHERE owner_type=$1 AND owner_id=$2 AND plugin_id=$3 AND status IN ('trial','active','past_due') AND offline_grace_until>now()
          ORDER BY starts_at DESC LIMIT 1`, [ownerType, ownerId, pluginId]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return { entitlementId: row.id, ownerType, ownerId, pluginId, planId: row.plan_id, status: row.status, seatAllowance: row.seat_allowance, startsAt: row.starts_at.toISOString(), renewsAt: row.renews_at?.toISOString() ?? null, offlineGraceUntil: row.offline_grace_until.toISOString() };
    });
  }

  async createWebhookEndpoint(actor: AuthenticatedSession, workspaceId: string, input: Omit<WebhookEndpointRecord, "id" | "publicId" | "workspaceId" | "signingSecretCiphertext" | "disabled">, publicId: string, signingSecretHash: Buffer, signingSecretCiphertext: Buffer, correlationId: string): Promise<WebhookEndpointRecord> {
    return this.withAccount(actor.accountId, async client => {
      const workflow = await client.query(`SELECT 1 FROM synced_workflows WHERE id=$1 AND workspace_id=$2 AND current_published_revision_id IS NOT NULL`, [input.workflowId, workspaceId]);
      if (!workflow.rowCount) throw new DomainError("webhook_workflow_not_published", "Webhook endpoints require a published workflow in this workspace.", 409);
      const id = randomUUID();
      await client.query(
        `INSERT INTO webhook_endpoints(id,public_id,workspace_id,workflow_id,signing_secret_hash,signing_secret_ciphertext,allowed_methods,schema,maximum_request_bytes,rate_limit_per_minute,retention_seconds,runner_policy,offline_expiry_seconds,redacted_fields,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, publicId, workspaceId, input.workflowId, signingSecretHash, signingSecretCiphertext, input.allowedMethods, input.schema, input.maximumRequestBytes, input.rateLimitPerMinute, input.retentionSeconds, input.runnerPolicy, input.offlineExpirySeconds, input.redactedFields, actor.accountId]
      );
      await appendAudit(client, actor, workspaceId, "webhook.created", "webhook_endpoint", id, null, { workflowId: input.workflowId, allowedMethods: input.allowedMethods, maximumRequestBytes: input.maximumRequestBytes, retentionSeconds: input.retentionSeconds, offlineExpirySeconds: input.offlineExpirySeconds }, correlationId);
      return { id, publicId, workspaceId, signingSecretCiphertext, disabled: false, ...input };
    });
  }

  async listWebhookEndpoints(actor: AuthenticatedSession, workspaceId: string) {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query<WebhookEndpointRow>(`SELECT id,public_id,workspace_id,workflow_id,signing_secret_ciphertext,allowed_methods,schema,maximum_request_bytes,rate_limit_per_minute,retention_seconds,runner_policy,offline_expiry_seconds,redacted_fields,disabled_at FROM webhook_endpoints WHERE workspace_id=$1 ORDER BY created_at DESC,id`, [workspaceId]);
      return result.rows.map(row => { const { signingSecretCiphertext: _secret, ...publicRecord } = webhookEndpointFromRow(row); return publicRecord; });
    });
  }

  async getWebhookEndpointByPublicId(publicId: string): Promise<WebhookEndpointRecord | null> {
    const result = await this.pool.query<WebhookEndpointRow>(`SELECT id,public_id,workspace_id,workflow_id,signing_secret_ciphertext,allowed_methods,schema,maximum_request_bytes,rate_limit_per_minute,retention_seconds,runner_policy,offline_expiry_seconds,redacted_fields,disabled_at FROM webhook_endpoints WHERE public_id=$1 AND disabled_at IS NULL`, [publicId]);
    if (!result.rowCount || !result.rows[0].signing_secret_ciphertext) return null;
    return webhookEndpointFromRow(result.rows[0]);
  }

  async rotateWebhookSecret(actor: AuthenticatedSession, workspaceId: string, endpointId: string, signingSecretHash: Buffer, signingSecretCiphertext: Buffer, correlationId: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      const result = await client.query(`UPDATE webhook_endpoints SET signing_secret_hash=$1,signing_secret_ciphertext=$2,rotated_at=now() WHERE id=$3 AND workspace_id=$4 AND disabled_at IS NULL`, [signingSecretHash, signingSecretCiphertext, endpointId, workspaceId]);
      if (!result.rowCount) return false;
      await appendAudit(client, actor, workspaceId, "webhook.secret_rotated", "webhook_endpoint", endpointId, null, { rotated: true }, correlationId);
      return true;
    });
  }

  async enqueueWebhookDelivery(endpoint: WebhookEndpointRecord, deliveryId: string, nonce: string, idempotencyKey: string, payloadCiphertext: Buffer, payloadHash: string, receivedAt: Date) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rate = await client.query<{ request_count: number }>(
        `INSERT INTO webhook_rate_windows(endpoint_id,window_started_at,request_count) VALUES($1,now(),1)
         ON CONFLICT(endpoint_id) DO UPDATE SET window_started_at=CASE WHEN webhook_rate_windows.window_started_at<=now()-interval '1 minute' THEN now() ELSE webhook_rate_windows.window_started_at END,
           request_count=CASE WHEN webhook_rate_windows.window_started_at<=now()-interval '1 minute' THEN 1 ELSE webhook_rate_windows.request_count+1 END RETURNING request_count`, [endpoint.id]
      );
      if (rate.rows[0].request_count > endpoint.rateLimitPerMinute) throw new DomainError("webhook_rate_limited", "Webhook endpoint rate limit exceeded.", 429);
      const expirySeconds = Math.min(endpoint.retentionSeconds, endpoint.offlineExpirySeconds);
      const expiresAt = new Date(receivedAt.getTime() + expirySeconds * 1_000);
      try {
        await client.query(
          `INSERT INTO webhook_deliveries(id,endpoint_id,workspace_id,payload_ciphertext,payload_hash,request_nonce,idempotency_key,received_at,expires_at,status,next_attempt_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',now())`,
          [deliveryId, endpoint.id, endpoint.workspaceId, payloadCiphertext, payloadHash, nonce, idempotencyKey, receivedAt, expiresAt]
        );
      } catch (error) {
        if (isPostgresUniqueViolation(error)) throw new DomainError("webhook_replay_detected", "Webhook nonce or idempotency key has already been received.", 409);
        throw error;
      }
      await client.query("COMMIT");
      return { status: "queued" as const, expiresAt: expiresAt.toISOString() };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async dequeueWebhookDeliveries(device: RunnerDeviceSession, limit: number) {
    return this.withAccount(device.accountId, async client => {
      await client.query(`UPDATE webhook_deliveries SET status='expired' WHERE workspace_id=$1 AND status='queued' AND expires_at<=now()`, [device.workspaceId]);
      await client.query(`UPDATE webhook_deliveries SET status='failed' WHERE workspace_id=$1 AND status='queued' AND attempt_count>=8`, [device.workspaceId]);
      const result = await client.query<{ id: string; endpoint_id: string; workspace_id: string; workflow_id: string; payload_ciphertext: Buffer; idempotency_key: string; received_at: Date; expires_at: Date; attempt_count: number }>(
        `SELECT d.id,d.endpoint_id,d.workspace_id,e.workflow_id,d.payload_ciphertext,d.idempotency_key,d.received_at,d.expires_at,d.attempt_count
           FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id JOIN runners runner ON runner.id=$2
          WHERE d.workspace_id=$1 AND d.status='queued' AND d.expires_at>now() AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=now())
            AND e.disabled_at IS NULL AND (e.runner_policy->>'runnerId' IS NULL OR e.runner_policy->>'runnerId'=$2::text)
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(e.runner_policy->'tags','[]'::jsonb)) AS required_tag(value) WHERE NOT (required_tag.value=ANY(runner.tags)))
          ORDER BY d.received_at,d.id FOR UPDATE SKIP LOCKED LIMIT $3`, [device.workspaceId, device.runnerId, limit]
      );
      for (const row of result.rows) {
        const delaySeconds = Math.min(300, 2 ** Math.min(row.attempt_count, 8));
        await client.query(`UPDATE webhook_deliveries SET delivered_runner_id=$1,attempt_count=attempt_count+1,next_attempt_at=now()+($2::text||' seconds')::interval WHERE id=$3`, [device.runnerId, delaySeconds, row.id]);
      }
      return result.rows.map(row => ({ deliveryId: row.id, endpointId: row.endpoint_id, workspaceId: row.workspace_id, workflowId: row.workflow_id, payloadCiphertext: row.payload_ciphertext, idempotencyKey: row.idempotency_key, receivedAt: row.received_at.toISOString(), expiresAt: row.expires_at.toISOString(), attemptCount: row.attempt_count + 1 }));
    });
  }

  async acknowledgeWebhookDelivery(device: RunnerDeviceSession, deliveryId: string, outcome: "delivered" | "retry" | "failed"): Promise<boolean> {
    return this.withAccount(device.accountId, async client => {
      const status = outcome === "retry" ? "queued" : outcome;
      const result = await client.query(
        `UPDATE webhook_deliveries SET status=$1,delivered_runner_id=CASE WHEN $1='queued' THEN NULL ELSE delivered_runner_id END,next_attempt_at=CASE WHEN $1='queued' THEN now()+interval '5 seconds' ELSE NULL END
          WHERE id=$2 AND workspace_id=$3 AND delivered_runner_id=$4 AND status='queued' AND expires_at>now()`,
        [status, deliveryId, device.workspaceId, device.runnerId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async listPluginRatings(pluginId: string, cursor: string | null, limit: number) {
    const values: unknown[] = [pluginId, limit + 1];
    const cursorClause = cursor ? "AND (rating.updated_at,rating.id)<(SELECT updated_at,id FROM plugin_ratings WHERE id=$3)" : "";
    if (cursor) values.push(cursor);
    const result = await this.pool.query<PluginRatingRow>(
      `SELECT rating.id,rating.plugin_id,account.display_name AS reviewer_name,rating.version_used,rating.stars,rating.review,rating.developer_response,rating.created_at,rating.updated_at
         FROM plugin_ratings rating JOIN accounts account ON account.id=rating.account_id
        WHERE rating.plugin_id=$1 AND rating.moderation_status='visible' ${cursorClause}
        ORDER BY rating.updated_at DESC,rating.id DESC LIMIT $2`, values
    );
    const page = result.rows.slice(0, limit);
    return { items: page.map(pluginRatingFromRow), nextCursor: result.rows.length > limit ? page.at(-1)!.id : null };
  }

  async upsertPluginRating(actor: AuthenticatedSession, pluginId: string, versionUsed: string, stars: number, review: string) {
    return this.withAccount(actor.accountId, async client => {
      const version = await client.query(`SELECT 1 FROM plugin_versions WHERE plugin_id=$1 AND version=$2`, [pluginId, versionUsed]);
      if (!version.rowCount) throw new DomainError("plugin_review_version_invalid", "The reviewed plugin version does not exist.", 400);
      const installation = await client.query<{ id: string }>(`SELECT installation.id FROM plugin_installations installation JOIN plugin_versions version ON version.id=installation.plugin_version_id WHERE installation.installed_by=$1 AND version.plugin_id=$2 ORDER BY installation.installed_at DESC LIMIT 1`, [actor.accountId, pluginId]);
      const purchase = await client.query(`SELECT 1 FROM entitlements WHERE owner_type='personal' AND owner_id=$1 AND plugin_id=$2 AND status NOT IN ('refunded','revoked') LIMIT 1`, [actor.accountId, pluginId]);
      if (!installation.rowCount && !purchase.rowCount) throw new DomainError("plugin_review_ineligible", "Install or purchase this plugin before leaving a review.", 403);
      const result = await client.query<PluginRatingRow>(
        `INSERT INTO plugin_ratings(plugin_id,account_id,installation_id,version_used,stars,review) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(plugin_id,account_id) DO UPDATE SET version_used=excluded.version_used,stars=excluded.stars,review=excluded.review,updated_at=now(),moderation_status='visible'
         RETURNING id,plugin_id,(SELECT display_name FROM accounts WHERE id=$2) AS reviewer_name,version_used,stars,review,developer_response,created_at,updated_at`,
        [pluginId, actor.accountId, installation.rows[0]?.id ?? null, versionUsed, stars, review]
      );
      await client.query(`UPDATE plugin_listings SET rating_average=(SELECT avg(stars) FROM plugin_ratings WHERE plugin_id=$1 AND moderation_status='visible'),rating_count=(SELECT count(*) FROM plugin_ratings WHERE plugin_id=$1 AND moderation_status='visible') WHERE plugin_id=$1`, [pluginId]);
      return pluginRatingFromRow(result.rows[0]);
    });
  }

  async respondToPluginRating(actor: AuthenticatedSession, publisherId: string, pluginId: string, reviewId: string, response: string, correlationId: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      await requirePublisherPermission(client, actor.accountId, publisherId, ["admin", "submit"]);
      const result = await client.query(`UPDATE plugin_ratings rating SET developer_response=$1,updated_at=now() FROM plugins plugin WHERE rating.id=$2 AND rating.plugin_id=$3 AND plugin.id=rating.plugin_id AND plugin.publisher_id=$4 AND rating.moderation_status='visible'`, [response, reviewId, pluginId, publisherId]);
      if (!result.rowCount) return false;
      await appendPlatformAudit(client, actor, "plugin.review_responded", "plugin_rating", reviewId, { pluginId }, correlationId);
      return true;
    });
  }

  async reportPluginRating(actor: AuthenticatedSession, pluginId: string, reviewId: string, reason: string): Promise<boolean> {
    return this.withAccount(actor.accountId, async client => {
      const rating = await client.query(`SELECT 1 FROM plugin_ratings WHERE id=$1 AND plugin_id=$2 AND moderation_status='visible'`, [reviewId, pluginId]);
      if (!rating.rowCount) return false;
      await client.query(`INSERT INTO plugin_rating_reports(rating_id,reported_by,reason,status) VALUES($1,$2,$3,'open') ON CONFLICT(rating_id,reported_by) DO UPDATE SET reason=excluded.reason,status='open',created_at=now(),resolved_at=NULL`, [reviewId, actor.accountId, reason]);
      return true;
    });
  }

  async updateRunner(actor: AuthenticatedSession, workspaceId: string, runnerId: string, displayName: string | null, status: "online" | "offline" | "paused" | "draining" | "maintenance" | null, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const before = await client.query<RunnerRow>(`SELECT id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status,current_workload,paired_at,last_seen_at FROM runners WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [runnerId, workspaceId]);
      if (!before.rowCount) return null;
      const result = await client.query<RunnerRow>(
        `UPDATE runners SET display_name=COALESCE($1,display_name),status=COALESCE($2,status)
          WHERE id=$3 RETURNING id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status,current_workload,paired_at,last_seen_at`,
        [displayName, status, runnerId]
      );
      await appendAudit(client, actor, workspaceId, "runner.updated", "runner", runnerId, { displayName: before.rows[0].display_name, status: before.rows[0].status }, { displayName: result.rows[0].display_name, status: result.rows[0].status }, correlationId);
      return runnerFromRow(result.rows[0]);
    });
  }

  async moveRunner(actor: AuthenticatedSession, sourceWorkspaceId: string, targetWorkspaceId: string, runnerId: string, correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const target = await client.query(`SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND account_id=$2`, [targetWorkspaceId, actor.accountId]);
      if (!target.rowCount) throw new DomainError("runner_move_target_invalid", "Target workspace is not accessible.", 403);
      const current = await client.query<{ current_workload: number }>(`SELECT current_workload FROM runners WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [runnerId, sourceWorkspaceId]);
      if (!current.rowCount) return null;
      if (current.rows[0].current_workload > 0) throw new DomainError("runner_not_drained", "Drain active executions before moving this runner.", 409);
      const result = await client.query<RunnerRow>(
        `UPDATE runners SET workspace_id=$1,status='offline' WHERE id=$2 AND workspace_id=$3 AND revoked_at IS NULL
         RETURNING id,workspace_id,display_name,operating_system,architecture,application_version,protocol_version,plugin_runtime_version,capabilities,safe_folder_labels,browser_engine,installed_plugin_versions,tags,status,current_workload,paired_at,last_seen_at`,
        [targetWorkspaceId, runnerId, sourceWorkspaceId]
      );
      if (!result.rowCount) return null;
      await appendAudit(client, actor, sourceWorkspaceId, "runner.moved_out", "runner", runnerId, { workspaceId: sourceWorkspaceId }, { workspaceId: targetWorkspaceId }, correlationId);
      await appendAudit(client, actor, targetWorkspaceId, "runner.moved_in", "runner", runnerId, { workspaceId: sourceWorkspaceId }, { workspaceId: targetWorkspaceId }, correlationId);
      return runnerFromRow(result.rows[0]);
    });
  }

  async rotateRunnerDeviceKey(device: RunnerDeviceSession, keyId: string, publicKeyDerBase64: string) {
    return this.withAccount(device.accountId, async client => {
      const runner = await client.query(`SELECT 1 FROM runners WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE`, [device.runnerId, device.workspaceId]);
      if (!runner.rowCount) throw new DomainError("runner_revoked", "Runner is no longer active.", 403);
      await client.query(`INSERT INTO runner_device_keys(runner_id,key_id,algorithm,public_key) VALUES($1,$2,'ed25519',decode($3,'base64'))`, [device.runnerId, keyId, publicKeyDerBase64]);
      await client.query(`UPDATE runner_device_keys SET revoked_at=now() WHERE runner_id=$1 AND key_id<>$2 AND revoked_at IS NULL`, [device.runnerId, keyId]);
      return { keyId };
    });
  }

  async listProtectedVariables(actor: AuthenticatedSession, workspaceId: string, environmentId: string) {
    return this.withAccount(actor.accountId, async client => {
      const environment = await client.query(`SELECT 1 FROM environments WHERE id=$1 AND workspace_id=$2`, [environmentId, workspaceId]);
      if (!environment.rowCount) throw new DomainError("environment_not_found", "Environment does not belong to this workspace.", 404);
      const result = await client.query<ProtectedVariableRow>(`SELECT id,environment_id,name,value_type,is_secret,NULL::bytea AS value_ciphertext,non_secret_value,description,allowed_workflow_ids,changed_by,changed_at FROM protected_variables WHERE environment_id=$1 ORDER BY name`, [environmentId]);
      return result.rows.map(protectedVariableFromRow);
    });
  }

  async upsertProtectedVariable(actor: AuthenticatedSession, workspaceId: string, environmentId: string, name: string, valueType: string, isSecret: boolean, valueCiphertext: Buffer | null, nonSecretValue: unknown | null, description: string, allowedWorkflowIds: string[], correlationId: string) {
    return this.withAccount(actor.accountId, async client => {
      const environment = await client.query(`SELECT 1 FROM environments WHERE id=$1 AND workspace_id=$2`, [environmentId, workspaceId]);
      if (!environment.rowCount) throw new DomainError("environment_not_found", "Environment does not belong to this workspace.", 404);
      const workflows = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM synced_workflows WHERE workspace_id=$1 AND id=ANY($2::uuid[])`, [workspaceId, allowedWorkflowIds]);
      if (Number(workflows.rows[0]?.count ?? 0) !== new Set(allowedWorkflowIds).size) throw new DomainError("protected_variable_workflow_scope_invalid", "Every allowed workflow must belong to this workspace.", 400);
      const result = await client.query<ProtectedVariableRow>(
        `INSERT INTO protected_variables(environment_id,name,value_type,is_secret,value_ciphertext,non_secret_value,description,allowed_workflow_ids,changed_by,changed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(environment_id,name) DO UPDATE SET value_type=excluded.value_type,is_secret=excluded.is_secret,value_ciphertext=excluded.value_ciphertext,non_secret_value=excluded.non_secret_value,description=excluded.description,allowed_workflow_ids=excluded.allowed_workflow_ids,changed_by=excluded.changed_by,changed_at=excluded.changed_at
         RETURNING id,environment_id,name,value_type,is_secret,NULL::bytea AS value_ciphertext,non_secret_value,description,allowed_workflow_ids,changed_by,changed_at`,
        [environmentId, name, valueType, isSecret, valueCiphertext, nonSecretValue, description, allowedWorkflowIds, actor.accountId]
      );
      await appendAudit(client, actor, workspaceId, "environment.variable_changed", "protected_variable", result.rows[0].id, null, { environmentId, name, valueType, isSecret, allowedWorkflowIds }, correlationId);
      return protectedVariableFromRow(result.rows[0]);
    });
  }

  async resolveProtectedVariables(device: RunnerDeviceSession, environmentId: string, workflowId: string, names: string[]) {
    return this.withAccount(device.accountId, async client => {
      const eligible = await client.query(
        `SELECT 1 FROM environments environment JOIN synced_workflows workflow ON workflow.workspace_id=environment.workspace_id JOIN workflow_revisions revision ON revision.id=workflow.current_published_revision_id JOIN runners runner ON runner.id=$4
          WHERE environment.id=$1 AND environment.workspace_id=$2 AND workflow.id=$3
            AND (revision.runner_policy->>'runnerId' IS NULL OR revision.runner_policy->>'runnerId'=$4::text)
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(revision.runner_policy->'tags','[]'::jsonb)) AS required_tag(value) WHERE NOT (required_tag.value=ANY(runner.tags)))`,
        [environmentId, device.workspaceId, workflowId, device.runnerId]
      );
      if (!eligible.rowCount) throw new DomainError("protected_variable_runner_ineligible", "Runner is not eligible for this published workflow and environment.", 403);
      const result = await client.query<ProtectedVariableRow>(
        `SELECT id,environment_id,name,value_type,is_secret,value_ciphertext,non_secret_value,description,allowed_workflow_ids,changed_by,changed_at FROM protected_variables
          WHERE environment_id=$1 AND name=ANY($2::text[]) AND $3=ANY(allowed_workflow_ids)`, [environmentId, names, workflowId]
      );
      const found = new Set(result.rows.map(row => row.name)); const missing = [...new Set(names)].filter(name => !found.has(name));
      if (missing.length) throw new DomainError("protected_variable_unavailable", `Protected variables are missing or not allowed for this workflow: ${missing.join(", ")}.`, 403);
      return result.rows.map(row => ({ ...protectedVariableFromRow(row), valueCiphertext: row.value_ciphertext }));
    });
  }

  private async withScim<T>(organisationId:string,provisioningAccountId:string,operation:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN");await client.query(`SELECT set_config('app.account_id',$1,true),set_config('app.scim_organisation_id',$2,true)`,[provisioningAccountId,organisationId]);const result=await operation(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  private async withAccount<T>(accountId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function validateRunnerPoolReferences(client:PoolClient,workspaceId:string,input:RunnerPoolInput):Promise<void>{
  const environment=await client.query(`SELECT 1 FROM environments WHERE id=$1 AND workspace_id=$2`,[input.environmentId,workspaceId]);
  if(!environment.rowCount)throw new DomainError("environment_not_found","Runner pool environment does not belong to this workspace.",404);
  const runnerIds=[...new Set(input.members.map(member=>member.runnerId))];
  if(runnerIds.length!==input.members.length)throw new DomainError("runner_pool_member_duplicate","A runner can appear only once in a pool.",400);
  if(runnerIds.length){
    const runners=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM runners WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND revoked_at IS NULL`,[workspaceId,runnerIds]);
    if(Number(runners.rows[0]?.count??0)!==runnerIds.length)throw new DomainError("runner_pool_member_invalid","Every pool member must be an active runner in this workspace.",400);
  }
}

async function replaceRunnerPoolMembers(client:PoolClient,poolId:string,members:RunnerPoolInput["members"]):Promise<void>{
  await client.query(`DELETE FROM runner_pool_members WHERE pool_id=$1`,[poolId]);
  for(const member of members)await client.query(`INSERT INTO runner_pool_members(pool_id,runner_id,priority) VALUES($1,$2,$3)`,[poolId,member.runnerId,member.priority]);
}

async function readRunnerPool(client:PoolClient,workspaceId:string,poolId:string):Promise<RunnerPoolRecord>{
  const result=await client.query<RunnerPoolRow>(`SELECT pool.id,pool.workspace_id,pool.environment_id,pool.name,pool.strategy,pool.region,pool.required_tags,pool.maximum_concurrency,pool.status,count(member.runner_id)::text AS member_count,pool.created_at,pool.updated_at FROM runner_pools pool LEFT JOIN runner_pool_members member ON member.pool_id=pool.id AND member.enabled WHERE pool.workspace_id=$1 AND pool.id=$2 GROUP BY pool.id`,[workspaceId,poolId]);
  if(!result.rowCount)throw new DomainError("runner_pool_not_found","Runner pool was not found in this workspace.",404);
  const row=result.rows[0];
  return {id:row.id,workspaceId:row.workspace_id,environmentId:row.environment_id,name:row.name,strategy:row.strategy,region:row.region,requiredTags:row.required_tags,maximumConcurrency:row.maximum_concurrency,status:row.status,memberCount:Number(row.member_count),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
}

async function appendOrganisationAudit(client:PoolClient,actor:AuthenticatedSession,organisationId:string,action:string,resourceId:string,after:Record<string,unknown>,correlationId:string):Promise<void>{
  const workspace=await client.query<{id:string}>(`SELECT id FROM workspaces WHERE organisation_id=$1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`,[organisationId]);
  if(workspace.rowCount)await appendAudit(client,actor,workspace.rows[0].id,action,"organisation_security",resourceId,null,after,correlationId);
}

function ssoConnectionFromRow(row:SsoConnectionRow):SsoConnectionRecord{return{id:row.id,organisationId:row.organisation_id,connectionType:row.connection_type,displayName:row.display_name,issuerUrl:row.issuer_url,clientIdentifier:row.client_identifier,verifiedDomains:row.verified_domains,enabled:row.enabled,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
function scimTokenFromRow(row:ScimTokenRow):ScimTokenSummary{return{id:row.id,organisationId:row.organisation_id,name:row.name,prefix:row.prefix,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),lastUsedAt:row.last_used_at?.toISOString()??null,revokedAt:row.revoked_at?.toISOString()??null};}
function scimUserFromRow(row:ScimUserRow):ScimManagedUserRecord{return{id:row.id,organisationId:row.organisation_id,accountId:row.account_id,externalId:row.external_id,userName:row.user_name,displayName:row.display_name,active:row.active,role:row.role_key,workspaceIds:row.workspace_ids,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}

interface WorkflowRevisionRow {
  id: string;
  workflow_id: string;
  parent_revision_id: string | null;
  schema_version: number;
  content_hash: string;
  encrypted_payload: string;
  payload_key_envelope: string;
  searchable_metadata: { name?: string; folderId?: string | null };
  plugin_requirements: WorkflowRevision["searchableMetadata"]["requiredPlugins"];
  permission_requirements: string[];
  runner_policy: Record<string, unknown>;
  editor_device_id: string;
  updated_at: Date;
  encryption_algorithm: "aes-256-gcm";
  encryption_key_version: number;
  sync_state: WorkflowRevision["syncState"];
}

interface RunnerPoolRow {id:string;workspace_id:string;environment_id:string;name:string;strategy:"least_loaded"|"round_robin"|"priority_failover";region:string|null;required_tags:string[];maximum_concurrency:number;status:"active"|"paused"|"draining";member_count:string;created_at:Date;updated_at:Date}
interface SsoConnectionRow{id:string;organisation_id:string;connection_type:"oidc"|"saml";display_name:string;issuer_url:string;client_identifier:string;verified_domains:string[];enabled:boolean;created_at:Date;updated_at:Date}
interface ScimTokenRow{id:string;organisation_id:string;name:string;prefix:string;created_at:Date;expires_at:Date;last_used_at:Date|null;revoked_at:Date|null}
interface ScimUserRow{id:string;organisation_id:string;account_id:string;external_id:string;user_name:string;display_name:string;active:boolean;role_key:string;workspace_ids:string[];created_at:Date;updated_at:Date}

interface RunnerPairingMetadata {
  operatingSystem: string; architecture: string; applicationVersion: string; protocolVersion: number; pluginRuntimeVersion: string;
  capabilities: Record<string, unknown>; safeFolderLabels: string[]; browserEngine: Record<string, unknown> | null;
  installedPluginVersions: Array<{ pluginId: string; version: string; packageIntegrity: string }>; tags: string[];
}

interface RunnerRow {
  id: string; workspace_id: string | null; display_name: string; operating_system: string; architecture: string; application_version: string;
  protocol_version: number; plugin_runtime_version: string; capabilities: Record<string, unknown>; safe_folder_labels: string[];
  browser_engine: Record<string, unknown> | null; installed_plugin_versions: RunnerPairingMetadata["installedPluginVersions"]; tags: string[];
  status: RunnerRecord["status"]; current_workload: number; paired_at: Date; last_seen_at: Date | null;
}

interface RunnerCommandRow {
  id: string; issuer_account_id: string; workspace_id: string; target_runner_id: string; action: RunnerCommand["action"]; workflow_revision_id: string | null;
  payload: Record<string, unknown>; authorization_context:RunnerCommand["authorizationContext"]; created_at: Date; expires_at: Date; idempotency_key: string; key_id: string; signature: string; status: RunnerCommand["status"];
}

interface RunSummaryRow { id: string; workspace_id: string; workflow_id: string; revision_id: string; runner_id: string; trigger: string; status: RunSummary["status"]; started_at: Date | null; duration_ms: string | number | null; failed_node_id: string | null; redacted_error_summary: string | null }

interface SharedConnectionRow { id: string; workspace_id: string; environment_id: string; provider: string; display_name: string; account_identity: string | null; granted_scopes: string[]; permitted_workflow_ids: string[]; permitted_role_ids: string[]; health: string; expires_at: Date | null; last_used_at: Date | null; created_by: string; approval_requirements: Record<string, unknown> }

interface WebhookEndpointRow { id: string; public_id: string; workspace_id: string; workflow_id: string; signing_secret_ciphertext: Buffer | null; allowed_methods: string[]; schema: Record<string, unknown> | null; maximum_request_bytes: number; rate_limit_per_minute: number; retention_seconds: number; runner_policy: Record<string, unknown>; offline_expiry_seconds: number; redacted_fields: string[]; disabled_at: Date | null }

interface PluginRatingRow { id: string; plugin_id: string; reviewer_name: string; version_used: string; stars: number; review: string; developer_response: string | null; created_at: Date; updated_at: Date }

interface ProtectedVariableRow { id: string; environment_id: string; name: string; value_type: string; is_secret: boolean; value_ciphertext: Buffer | null; non_secret_value: unknown | null; description: string; allowed_workflow_ids: string[]; changed_by: string; changed_at: Date }

function protectedVariableFromRow(row: ProtectedVariableRow) {
  return { id: row.id, environmentId: row.environment_id, name: row.name, valueType: row.value_type, isSecret: row.is_secret, nonSecretValue: row.is_secret ? null : row.non_secret_value, description: row.description, allowedWorkflowIds: row.allowed_workflow_ids, changedBy: row.changed_by, changedAt: row.changed_at.toISOString() };
}

function pluginRatingFromRow(row: PluginRatingRow) {
  return { reviewId: row.id, pluginId: row.plugin_id, reviewerName: row.reviewer_name, versionUsed: row.version_used, stars: row.stars, review: row.review, developerResponse: row.developer_response, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function webhookEndpointFromRow(row: WebhookEndpointRow): WebhookEndpointRecord {
  if (!row.signing_secret_ciphertext) throw new DomainError("webhook_secret_unavailable", "Webhook endpoint must rotate its signing secret before it can receive events.", 409);
  return { id: row.id, publicId: row.public_id, workspaceId: row.workspace_id, workflowId: row.workflow_id, signingSecretCiphertext: row.signing_secret_ciphertext, allowedMethods: row.allowed_methods, schema: row.schema, maximumRequestBytes: row.maximum_request_bytes, rateLimitPerMinute: row.rate_limit_per_minute, retentionSeconds: row.retention_seconds, runnerPolicy: row.runner_policy, offlineExpirySeconds: row.offline_expiry_seconds, redactedFields: row.redacted_fields, disabled: row.disabled_at !== null };
}

function sharedConnectionFromRow(row: SharedConnectionRow): SharedConnectionRecord {
  return { id: row.id, workspaceId: row.workspace_id, environmentId: row.environment_id, provider: row.provider, displayName: row.display_name, accountIdentity: row.account_identity, grantedScopes: row.granted_scopes, permittedWorkflowIds: row.permitted_workflow_ids, permittedRoleIds: row.permitted_role_ids, health: row.health, expiresAt: row.expires_at?.toISOString() ?? null, lastUsedAt: row.last_used_at?.toISOString() ?? null, createdBy: row.created_by, approvalRequirements: row.approval_requirements };
}

function runSummaryFromRow(row: RunSummaryRow): RunSummary {
  return { id: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id, revisionId: row.revision_id, runnerId: row.runner_id, trigger: row.trigger, status: row.status, startedAt: row.started_at?.toISOString() ?? null, durationMs: row.duration_ms === null ? null : Number(row.duration_ms), failedNodeId: row.failed_node_id, redactedErrorSummary: row.redacted_error_summary };
}

interface ApprovalRow { id: string; workflow_id: string; revision_id: string; status: WorkflowApprovalRecord["status"]; created_at: Date }

function approvalFromRow(row: ApprovalRow, requiredApprovals: number, approvalCount: number): WorkflowApprovalRecord {
  return { approvalId: row.id, workflowId: row.workflow_id, revisionId: row.revision_id, status: row.status, requiredApprovals, approvalCount, createdAt: row.created_at.toISOString() };
}

async function requiredApprovalCount(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ policy_value: unknown }>(`SELECT policy_value FROM governance_policies WHERE workspace_id=$1 AND policy_key='required_approval_count'`, [workspaceId]);
  const value = result.rows[0]?.policy_value;
  const count = typeof value === "number" ? value : value && typeof value === "object" && "count" in value ? Number((value as { count: unknown }).count) : 1;
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : 1;
}

function runnerFromRow(row: RunnerRow): RunnerRecord {
  return { runnerId: row.id, workspaceId: row.workspace_id, displayName: row.display_name, operatingSystem: row.operating_system, architecture: row.architecture, applicationVersion: row.application_version, protocolVersion: row.protocol_version, pluginRuntimeVersion: row.plugin_runtime_version, capabilities: row.capabilities, safeFolderLabels: row.safe_folder_labels, browserEngine: row.browser_engine, installedPluginVersions: row.installed_plugin_versions, tags: row.tags, status: row.status, currentWorkload: row.current_workload, pairedAt: row.paired_at.toISOString(), lastSeenAt: row.last_seen_at?.toISOString() ?? null };
}

function runnerCommandFromRow(row: RunnerCommandRow): RunnerCommand {
  return { commandId: row.id, issuerAccountId: row.issuer_account_id, workspaceId: row.workspace_id, targetRunnerId: row.target_runner_id, action: row.action, workflowRevisionId: row.workflow_revision_id, payload: row.payload, authorizationContext:row.authorization_context, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), idempotencyKey: row.idempotency_key, keyId: row.key_id, signature: row.signature.replace(/\s/g, ""), status: row.status };
}

export function incompatiblePluginRequirements(required: RunnerPairingMetadata["installedPluginVersions"], installed: RunnerPairingMetadata["installedPluginVersions"]): string[] {
  const available = new Set(installed.map(plugin => `${plugin.pluginId}@${plugin.version}#${plugin.packageIntegrity}`));
  return required.filter(plugin => !available.has(`${plugin.pluginId}@${plugin.version}#${plugin.packageIntegrity}`)).map(plugin => `${plugin.pluginId}@${plugin.version}`);
}

function workflowRevisionFromRow(row: WorkflowRevisionRow): WorkflowRevision {
  return {
    workflowId: row.workflow_id,
    revisionId: row.id,
    parentRevisionId: row.parent_revision_id,
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
    editorDeviceId: row.editor_device_id,
    updatedAt: row.updated_at.toISOString(),
    syncState: row.sync_state,
    encryption: { algorithm: row.encryption_algorithm, keyVersion: row.encryption_key_version },
    encryptedPayload: row.encrypted_payload.replace(/\s/g, ""),
    payloadKeyEnvelope: row.payload_key_envelope.replace(/\s/g, ""),
    searchableMetadata: {
      name: row.searchable_metadata.name ?? "Encrypted workflow",
      folderId: row.searchable_metadata.folderId ?? null,
      requiredPlugins: row.plugin_requirements,
      permissionRequirements: row.permission_requirements,
      runnerPolicy: row.runner_policy
    }
  };
}

export function detectSyncConflict(currentRevisionId: string | null, parentRevisionId: string | null): string | null {
  return currentRevisionId && currentRevisionId !== parentRevisionId ? currentRevisionId : null;
}

export function executablePayloadMatchesRevision(payloadValue: unknown, revisionId: string, workflowId: string, contentHash: string): boolean {
  if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) return false;
  const payload = payloadValue as { workflowRevisionId?: unknown; contentHash?: unknown; workflow?: { id?: unknown } };
  return payload.workflowRevisionId === revisionId && payload.contentHash === contentHash && payload.workflow?.id === workflowId;
}

interface SubmissionRow {
  review_id: string; plugin_version_id: string; publisher_public_id: string; publisher_key_id: string;
  plugin_id: string; version: string; package_integrity: string; package_size: number; package_object_key: string; status: string;
}

interface MarketplaceRow {
  plugin_id: string; name: string; summary: string; visibility: MarketplaceListing["visibility"];
  publisher_public_id: string; public_name: string; publisher_verified: boolean; version: string; package_integrity: string;
  categories: string[]; keywords: string[]; pricing: Record<string, unknown>; licence: string; documentation_url: string;
  privacy_policy_url: string | null; support_url: string; screenshots: unknown[]; security_notices: unknown[]; capabilities: unknown[];
  network_domains: unknown[]; nodes: unknown[]; minimum_host_version: string; maximum_host_version: string | null;
  install_count: string | number; rating_average: string | number | null; rating_count: string | number; updated_at: Date;
}

function marketplaceOrder(sort: MarketplaceQuery["sort"]): string {
  if (sort === "installs") return "l.install_count DESC, pl.id DESC";
  if (sort === "rating") return "l.rating_average DESC NULLS LAST, pl.id DESC";
  return "l.updated_at DESC, pl.id DESC";
}

function marketplaceCursorClause(sort: MarketplaceQuery["sort"]): string {
  if (sort === "installs") return "AND (l.install_count, pl.id) < (SELECT install_count, plugin_id FROM plugin_listings WHERE plugin_id = $9)";
  if (sort === "rating") return "AND (COALESCE(l.rating_average, -1), pl.id) < (SELECT COALESCE(rating_average, -1), plugin_id FROM plugin_listings WHERE plugin_id = $9)";
  return "AND (l.updated_at, pl.id) < (SELECT updated_at, plugin_id FROM plugin_listings WHERE plugin_id = $9)";
}

export function hostCompatible(hostVersion: string, minimum: string, maximum: string | null): boolean {
  try {
    return satisfies(hostVersion, minimum, { includePrerelease: true }) && (!maximum || satisfies(hostVersion, maximum, { includePrerelease: true }));
  } catch {
    return false;
  }
}

function marketplaceFromRow(row: MarketplaceRow): MarketplaceListing {
  return { pluginId: row.plugin_id, name: row.name, summary: row.summary, publisher: { publicId: row.publisher_public_id, publicName: row.public_name, verified: row.publisher_verified }, version: row.version, packageIntegrity: row.package_integrity, categories: row.categories, keywords: row.keywords, pricing: row.pricing, licence: row.licence, documentationUrl: row.documentation_url, privacyPolicyUrl: row.privacy_policy_url, supportUrl: row.support_url, screenshots: row.screenshots, securityNotices: row.security_notices, capabilities: row.capabilities, networkDomains: row.network_domains, nodes: row.nodes ?? [], minimumHostVersion: row.minimum_host_version, maximumHostVersion: row.maximum_host_version, installCount: Number(row.install_count), ratingAverage: row.rating_average === null ? null : Number(row.rating_average), ratingCount: Number(row.rating_count), updatedAt: row.updated_at.toISOString(), visibility: row.visibility };
}

function submissionFromRow(row: SubmissionRow): PluginSubmissionRecord {
  return { reviewId: row.review_id, pluginVersionId: row.plugin_version_id, publisherPublicId: row.publisher_public_id, publisherKeyId: row.publisher_key_id, pluginId: row.plugin_id, version: row.version, packageIntegrity: row.package_integrity, packageSize: Number(row.package_size), packageObjectKey: row.package_object_key, status: row.status };
}

async function requirePublisherPermission(client: PoolClient, accountId: string, publisherId: string, accepted: string[]): Promise<{ public_id: string }> {
  const result = await client.query<{ public_id: string }>(
    `SELECT p.public_id FROM publishers p JOIN publisher_members pm ON pm.publisher_id = p.id
      WHERE p.id = $1 AND pm.account_id = $2 AND pm.permission = ANY($3::text[]) LIMIT 1`,
    [publisherId, accountId, accepted]
  );
  if (!result.rowCount) throw new DomainError("publisher_permission_denied", "You do not have the required permission for this publisher.", 403);
  return result.rows[0];
}

async function appendPlatformAudit(client: PoolClient, actor: AuthenticatedSession, action: string, resourceType: string, resourceId: string, summary: Record<string, unknown>, correlationId: string) {
  await client.query(`INSERT INTO platform_audit_events(actor_account_id, action, resource_type, resource_id, summary, correlation_id) VALUES($1,$2,$3,$4,$5,$6)`, [actor.accountId, action, resourceType, resourceId, redact(summary), correlationId]);
}

async function appendAudit(client: PoolClient, actor: AuthenticatedSession, workspaceId: string, action: string, resourceType: string, resourceId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, correlationId: string) {
  await client.query(
    `INSERT INTO audit_events(id, occurred_at, actor_account_id, workspace_id, action, resource_type, resource_id, before_summary, after_summary, correlation_id)
     VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), actor.accountId, workspaceId, action, resourceType, resourceId, before, redact(after), correlationId]
  );
}

function redact(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|cookie|authorization|payload|ciphertext/i.test(key) ? "[REDACTED]" : item]));
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505";
}

function sameStringSet(left:string[],right:string[]):boolean{return JSON.stringify([...new Set(left)].sort())===JSON.stringify([...new Set(right)].sort());}
function samePluginRequirements(left:DeploymentRecord["requiredPlugins"],right:DeploymentRecord["requiredPlugins"]):boolean{return JSON.stringify(left.map(item=>`${item.pluginId}\u0000${item.version}\u0000${item.packageIntegrity}`).sort())===JSON.stringify(right.map(item=>`${item.pluginId}\u0000${item.version}\u0000${item.packageIntegrity}`).sort());}

function matchesBillingMode(value: unknown): value is "payment" | "subscription" { return value === "payment" || value === "subscription"; }

function stripeEntitlementStatus(status: string): "trial" | "active" | "past_due" | "expired" | "revoked" {
  if (status === "trialing") return "trial";
  if (status === "active") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "paused") return "revoked";
  return "expired";
}
