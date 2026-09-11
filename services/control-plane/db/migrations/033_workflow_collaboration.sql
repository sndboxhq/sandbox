CREATE TABLE workflow_collaboration_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES synced_workflows(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES accounts(id),
  latest_sequence bigint NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  UNIQUE(id, workspace_id, workflow_id)
);
CREATE INDEX workflow_collaboration_active_idx ON workflow_collaboration_sessions(workspace_id, workflow_id, expires_at DESC) WHERE closed_at IS NULL;

CREATE TABLE workflow_collaboration_members (
  session_id uuid NOT NULL REFERENCES workflow_collaboration_sessions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[a-fA-F0-9]{6}$'),
  encrypted_presence bytea,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, account_id, device_id)
);
CREATE INDEX workflow_collaboration_presence_idx ON workflow_collaboration_members(session_id, last_seen_at DESC);

CREATE TABLE workflow_collaboration_operations (
  session_id uuid NOT NULL REFERENCES workflow_collaboration_sessions(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  operation_id uuid NOT NULL,
  workflow_id uuid NOT NULL REFERENCES synced_workflows(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  base_sequence bigint NOT NULL CHECK (base_sequence >= 0),
  client_sequence bigint NOT NULL CHECK (client_sequence >= 0),
  encrypted_payload bytea NOT NULL CHECK (octet_length(encrypted_payload) BETWEEN 16 AND 1125000),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  client_created_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, sequence),
  UNIQUE(session_id, operation_id)
);
CREATE INDEX workflow_collaboration_operations_since_idx ON workflow_collaboration_operations(session_id, sequence);
