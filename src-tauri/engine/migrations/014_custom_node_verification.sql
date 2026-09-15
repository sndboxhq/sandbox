CREATE TABLE IF NOT EXISTS custom_node_verifications (
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  output_coverage_json TEXT NOT NULL,
  branch_coverage_json TEXT NOT NULL,
  passed_at TEXT NOT NULL,
  PRIMARY KEY(workflow_id,node_id),
  FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS custom_node_verifications_fingerprint_idx
  ON custom_node_verifications(fingerprint);
PRAGMA user_version = 14;
