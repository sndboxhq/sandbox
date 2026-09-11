use crate::{
    BrowserDiagnostics, BrowserProfile, ConnectionMetadata, ConnectionStatus, CustomNodeVerification, EngineError,
    ExecutionError, ExecutionRecord, ExecutionStatus, InstalledPlugin, PendingApproval,
    PluginInstallState, PluginRevocation, RecordedWorkflowDraft, Workflow, WorkflowMetadata,
    WorkflowMetadataPatch, WorkflowRevisionSummary, WorkflowSummary,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        let connection = Connection::open(path).map_err(storage)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(storage)?;
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn in_memory() -> Result<Self, EngineError> {
        let connection = Connection::open_in_memory().map_err(storage)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(storage)?;
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage)?;
        if version < 1 {
            connection
                .execute_batch(include_str!("../migrations/001_initial.sql"))
                .map_err(storage)?;
        }
        if version < 2 {
            connection
                .execute_batch(include_str!("../migrations/002_schedule_state.sql"))
                .map_err(storage)?;
        }
        if version < 3 {
            connection
                .execute_batch(include_str!("../migrations/003_browser_integrations.sql"))
                .map_err(storage)?;
        }
        if version < 4 {
            connection
                .execute_batch(include_str!("../migrations/004_integration_polling.sql"))
                .map_err(storage)?;
        }
        if version < 5 {
            connection
                .execute_batch(include_str!("../migrations/005_plugin_installations.sql"))
                .map_err(storage)?;
        }
        if version < 6 {
            connection
                .execute_batch(include_str!("../migrations/006_plugin_execution.sql"))
                .map_err(storage)?;
        }
        if version < 7 {
            connection
                .execute_batch(include_str!(
                    "../migrations/007_runner_command_receipts.sql"
                ))
                .map_err(storage)?;
        }
        if version < 8 {
            connection
                .execute_batch(include_str!("../migrations/008_workflow_metadata.sql"))
                .map_err(storage)?;
        }
        if version < 9 {
            connection
                .execute_batch(include_str!(
                    "../migrations/009_workflow_revisions_and_state.sql"
                ))
                .map_err(storage)?;
        }
        if version < 10 {
            connection
                .execute_batch(include_str!(
                    "../migrations/010_first_party_integrations.sql"
                ))
                .map_err(storage)?;
        }
        if version < 11 {
            connection
                .execute_batch(include_str!("../migrations/011_poll_backoff.sql"))
                .map_err(storage)?;
        }
        if version < 12 {
            connection
                .execute_batch(include_str!("../migrations/012_code_expressions.sql"))
                .map_err(storage)?;
        }
        if version < 13 {
            connection
                .execute_batch(include_str!("../migrations/013_collection_checkpoints.sql"))
                .map_err(storage)?;
        }
        if version < 14 {
            connection
                .execute_batch(include_str!("../migrations/014_custom_node_verification.sql"))
                .map_err(storage)?;
        }
        migrate_saved_workflows(&connection)?;
        backfill_workflow_revisions(&connection)?;
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage)
    }

    pub fn save_custom_node_verification(&self, verification: &CustomNodeVerification) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO custom_node_verifications(workflow_id,node_id,fingerprint,runtime_version,output_coverage_json,branch_coverage_json,passed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workflow_id,node_id) DO UPDATE SET fingerprint=excluded.fingerprint,runtime_version=excluded.runtime_version,output_coverage_json=excluded.output_coverage_json,branch_coverage_json=excluded.branch_coverage_json,passed_at=excluded.passed_at",
            params![verification.workflow_id,verification.node_id,verification.fingerprint,verification.runtime_version,serde_json::to_string(&verification.output_coverage).map_err(storage)?,serde_json::to_string(&verification.branch_coverage).map_err(storage)?,verification.passed_at.to_rfc3339()]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn custom_node_verification(&self, workflow_id: &str, node_id: &str) -> Result<Option<CustomNodeVerification>, EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.query_row(
            "SELECT fingerprint,runtime_version,output_coverage_json,branch_coverage_json,passed_at FROM custom_node_verifications WHERE workflow_id=? AND node_id=?",
            params![workflow_id,node_id],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?))
        ).optional().map_err(storage)?.map(|(fingerprint,runtime_version,outputs,branches,passed_at)| Ok(CustomNodeVerification {
            workflow_id: workflow_id.into(), node_id: node_id.into(), fingerprint, runtime_version,
            output_coverage: serde_json::from_str(&outputs).map_err(storage)?,
            branch_coverage: serde_json::from_str(&branches).map_err(storage)?,
            passed_at: parse_time(&passed_at),
        })).transpose()
    }

    pub fn clear_custom_node_verification(&self, workflow_id: &str, node_id: &str) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "DELETE FROM custom_node_verifications WHERE workflow_id=? AND node_id=?", params![workflow_id,node_id]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn save_loop_iteration_checkpoint(
        &self,
        execution_id: &str,
        node_id: &str,
        iteration_id: &str,
        attempt: u32,
        status: &str,
        batch_hash: &str,
        result: &Value,
    ) -> Result<(), EngineError> {
        if !matches!(status, "active" | "completed" | "failed" | "uncertain") {
            return Err(EngineError::Storage(
                "Invalid loop checkpoint status.".into(),
            ));
        }
        self.connection.lock().map_err(|_|EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO loop_iteration_checkpoints(execution_id,node_id,iteration_id,attempt,status,batch_hash,result_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(execution_id,node_id,iteration_id) DO UPDATE SET attempt=excluded.attempt,status=excluded.status,batch_hash=excluded.batch_hash,result_json=excluded.result_json,updated_at=excluded.updated_at",
            params![execution_id,node_id,iteration_id,attempt,status,batch_hash,serde_json::to_string(result).map_err(storage)?,Utc::now().to_rfc3339()]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn loop_iteration_checkpoints(
        &self,
        execution_id: &str,
        node_id: &str,
    ) -> Result<Vec<(String, u32, String, String, Value)>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement=connection.prepare("SELECT iteration_id,attempt,status,batch_hash,result_json FROM loop_iteration_checkpoints WHERE execution_id=? AND node_id=? ORDER BY iteration_id").map_err(storage)?;
        let rows = statement
            .query_map(params![execution_id, node_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(storage)?;
        rows.map(|row| {
            let (id, attempt, status, hash, json) = row.map_err(storage)?;
            Ok((
                id,
                attempt,
                status,
                hash,
                serde_json::from_str(&json).map_err(storage)?,
            ))
        })
        .collect()
    }

    pub fn create_file_grant(
        &self,
        absolute_path: &str,
        maximum_bytes: u64,
        expires_at: DateTime<Utc>,
    ) -> Result<String, EngineError> {
        let id = Uuid::new_v4().to_string();
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "INSERT INTO file_grants(id,absolute_path,maximum_bytes,expires_at,consumed_at) VALUES(?,?,?,?,NULL)",
                params![id, absolute_path, maximum_bytes.min(i64::MAX as u64) as i64, expires_at.to_rfc3339()],
            )
            .map_err(storage)?;
        Ok(id)
    }

    pub fn resolve_file_grant(&self, id: &str) -> Result<Option<(String, u64)>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let value: Option<(String, i64, String, Option<String>)> = connection
            .query_row(
                "SELECT absolute_path,maximum_bytes,expires_at,consumed_at FROM file_grants WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(storage)?;
        Ok(value.and_then(|(path, maximum, expires, consumed)| {
            let expiry = DateTime::parse_from_rfc3339(&expires)
                .ok()?
                .with_timezone(&Utc);
            (consumed.is_none() && expiry > Utc::now()).then_some((path, maximum.max(0) as u64))
        }))
    }

    pub fn consume_file_grant(&self, id: &str) -> Result<bool, EngineError> {
        let changed = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "UPDATE file_grants SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?",
                params![Utc::now().to_rfc3339(), id, Utc::now().to_rfc3339()],
            )
            .map_err(storage)?;
        Ok(changed == 1)
    }

    pub fn poll_cursor(
        &self,
        workflow_id: &str,
        node_id: &str,
        runner_id: &str,
        connection_id: &str,
        plugin_id: &str,
        plugin_version: &str,
    ) -> Result<Option<(Value, bool, Option<DateTime<Utc>>, u32)>, EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT cursor_json,baseline_complete,next_poll_at,failure_count FROM integration_poll_cursors WHERE workflow_id=? AND node_id=? AND runner_id=? AND connection_id=? AND plugin_id=? AND plugin_version=?",
                params![workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version],
                |row| {
                    let cursor: Option<String> = row.get(0)?;
                    let baseline: bool = row.get(1)?;
                    let next: Option<String> = row.get(2)?;
                    let failures: u32 = row.get(3)?;
                    Ok((cursor.and_then(|value| serde_json::from_str(&value).ok()).unwrap_or(Value::Null), baseline, next.as_deref().map(parse_time), failures))
                },
            )
            .optional()
            .map_err(storage)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_poll_failure(
        &self,
        workflow_id: &str,
        node_id: &str,
        runner_id: &str,
        connection_id: &str,
        plugin_id: &str,
        plugin_version: &str,
        next_poll_at: DateTime<Utc>,
        error: &str,
    ) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO integration_poll_cursors(workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version,cursor_json,baseline_complete,last_polled_at,next_poll_at,last_error,failure_count) VALUES(?,?,?,?,?,?,NULL,0,?,?,?,1) ON CONFLICT(workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version) DO UPDATE SET last_polled_at=excluded.last_polled_at,next_poll_at=excluded.next_poll_at,last_error=excluded.last_error,failure_count=integration_poll_cursors.failure_count+1",
            params![workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version,Utc::now().to_rfc3339(),next_poll_at.to_rfc3339(),error.chars().take(4096).collect::<String>()],
        ).map_err(storage)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_poll_checkpoint(
        &self,
        workflow_id: &str,
        node_id: &str,
        runner_id: &str,
        connection_id: &str,
        plugin_id: &str,
        plugin_version: &str,
        cursor: &Value,
        baseline_complete: bool,
        next_poll_at: DateTime<Utc>,
        event_keys: &[String],
    ) -> Result<Vec<String>, EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let now = Utc::now();
        let mut accepted = Vec::new();
        for event_key in event_keys {
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO integration_poll_dedup(workflow_id,node_id,event_key,observed_at) VALUES(?,?,?,?)",
                params![workflow_id,node_id,event_key,now.to_rfc3339()],
            ).map_err(storage)?;
            if inserted == 1 {
                accepted.push(event_key.clone());
            }
        }
        transaction.execute(
            "INSERT INTO integration_poll_cursors(workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version,cursor_json,baseline_complete,last_polled_at,next_poll_at,last_error,failure_count) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,0) ON CONFLICT(workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version) DO UPDATE SET cursor_json=excluded.cursor_json,baseline_complete=excluded.baseline_complete,last_polled_at=excluded.last_polled_at,next_poll_at=excluded.next_poll_at,last_error=NULL,failure_count=0",
            params![workflow_id,node_id,runner_id,connection_id,plugin_id,plugin_version,serde_json::to_string(cursor).map_err(storage)?,baseline_complete,now.to_rfc3339(),next_poll_at.to_rfc3339()],
        ).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(accepted)
    }

    pub fn set_setting<T: Serialize>(&self, key: &str, value: &T) -> Result<(), EngineError> {
        if key.is_empty() || key.len() > 128 {
            return Err(EngineError::Storage("Setting key is invalid.".into()));
        }
        let encoded = serde_json::to_string(value).map_err(storage)?;
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![key, encoded, Utc::now().to_rfc3339()],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn get_setting<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, EngineError> {
        let encoded: Option<String> = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT value_json FROM settings WHERE key=?",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        encoded
            .map(|value| serde_json::from_str(&value).map_err(storage))
            .transpose()
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute("DELETE FROM settings WHERE key=?", [key])
            .map_err(storage)?;
        Ok(())
    }

    pub fn claim_remote_command(
        &self,
        command_id: &str,
        runner_id: &str,
        workspace_id: &str,
        idempotency_key: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<bool, EngineError> {
        if [command_id, runner_id, workspace_id, idempotency_key]
            .iter()
            .any(|value| value.is_empty() || value.len() > 200)
        {
            return Err(EngineError::Validation(
                "Remote command identity is invalid.".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "INSERT OR IGNORE INTO runner_command_receipts(command_id,runner_id,workspace_id,idempotency_key,status,received_at,expires_at) VALUES(?,?,?,?,?,?,?)",
                params![command_id, runner_id, workspace_id, idempotency_key, "claimed", Utc::now().to_rfc3339(), expires_at.to_rfc3339()],
            )
            .map_err(storage)?;
        Ok(changed == 1)
    }

    pub fn complete_remote_command(
        &self,
        command_id: &str,
        status: &str,
    ) -> Result<(), EngineError> {
        if !matches!(status, "accepted" | "rejected" | "completed" | "expired") {
            return Err(EngineError::Validation(
                "Remote command receipt status is invalid.".into(),
            ));
        }
        let changed = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "UPDATE runner_command_receipts SET status=?,completed_at=? WHERE command_id=?",
                params![status, Utc::now().to_rfc3339(), command_id],
            )
            .map_err(storage)?;
        if changed != 1 {
            return Err(EngineError::Storage(
                "Remote command receipt was not found.".into(),
            ));
        }
        Ok(())
    }

    pub fn remote_command_status(&self, command_id: &str) -> Result<Option<String>, EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT status FROM runner_command_receipts WHERE command_id=?",
                [command_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)
    }

    pub fn save_installed_plugin(&self, plugin: &InstalledPlugin) -> Result<(), EngineError> {
        if !matches!(plugin.owner_type.as_str(), "personal" | "workspace") {
            return Err(EngineError::Validation(
                "Plugin owner type must be personal or workspace.".into(),
            ));
        }
        if !matches!(
            plugin.source.as_str(),
            "marketplace" | "private" | "development"
        ) {
            return Err(EngineError::Validation(
                "Plugin source must be marketplace, private, or development.".into(),
            ));
        }
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "INSERT INTO installed_plugins(plugin_id,version,package_integrity,publisher_id,publisher_key_id,owner_type,owner_id,source,development,state,manifest_json,requested_permissions_json,approved_permissions_json,update_requires_review,package_path,installed_at,updated_at,publisher_public_key_pem) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    plugin.plugin_id,
                    plugin.version,
                    plugin.package_integrity,
                    plugin.publisher_id,
                    plugin.publisher_key_id,
                    plugin.owner_type,
                    plugin.owner_id,
                    plugin.source,
                    plugin.development,
                    plugin_install_state_str(plugin.state),
                    serde_json::to_string(&plugin.manifest).map_err(storage)?,
                    serde_json::to_string(&plugin.requested_permissions).map_err(storage)?,
                    serde_json::to_string(&plugin.approved_permissions).map_err(storage)?,
                    plugin.update_requires_review,
                    plugin.package_path,
                    plugin.installed_at.to_rfc3339(),
                    plugin.updated_at.to_rfc3339(),
                    plugin.publisher_public_key_pem,
                ],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn list_installed_plugins(
        &self,
        owner_type: &str,
        owner_id: &str,
    ) -> Result<Vec<InstalledPlugin>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection
            .prepare("SELECT plugin_id,version,package_integrity,publisher_id,publisher_key_id,owner_type,owner_id,source,development,state,manifest_json,requested_permissions_json,approved_permissions_json,update_requires_review,package_path,installed_at,updated_at,publisher_public_key_pem FROM installed_plugins WHERE owner_type=? AND owner_id=? ORDER BY plugin_id,installed_at DESC")
            .map_err(storage)?;
        let values = statement
            .query_map(params![owner_type, owner_id], parse_installed_plugin)
            .map_err(storage)?
            .map(|row| row.map_err(storage))
            .collect();
        values
    }

    pub fn get_installed_plugin(
        &self,
        plugin_id: &str,
        version: &str,
        integrity: &str,
        owner_type: &str,
        owner_id: &str,
    ) -> Result<Option<InstalledPlugin>, EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT plugin_id,version,package_integrity,publisher_id,publisher_key_id,owner_type,owner_id,source,development,state,manifest_json,requested_permissions_json,approved_permissions_json,update_requires_review,package_path,installed_at,updated_at,publisher_public_key_pem FROM installed_plugins WHERE plugin_id=? AND version=? AND package_integrity=? AND owner_type=? AND owner_id=?",
                params![plugin_id, version, integrity, owner_type, owner_id],
                parse_installed_plugin,
            )
            .optional()
            .map_err(storage)
    }

    pub fn approve_plugin_permissions(
        &self,
        plugin_id: &str,
        version: &str,
        integrity: &str,
        owner_type: &str,
        owner_id: &str,
    ) -> Result<InstalledPlugin, EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let (previous, requested): (String, String) = transaction
            .query_row(
                "SELECT approved_permissions_json,requested_permissions_json FROM installed_plugins WHERE plugin_id=? AND version=? AND package_integrity=? AND owner_type=? AND owner_id=? AND state!='revoked'",
                params![plugin_id, version, integrity, owner_type, owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?
            .ok_or_else(|| EngineError::Validation("The exact plugin version is not available for permission approval.".into()))?;
        let now = Utc::now();
        transaction
            .execute(
                "UPDATE installed_plugins SET approved_permissions_json=requested_permissions_json,update_requires_review=0,updated_at=? WHERE plugin_id=? AND version=? AND package_integrity=? AND owner_type=? AND owner_id=?",
                params![now.to_rfc3339(), plugin_id, version, integrity, owner_type, owner_id],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO plugin_permission_audit(id,plugin_id,version,package_integrity,owner_type,owner_id,previous_permissions_json,approved_permissions_json,approved_at) VALUES(?,?,?,?,?,?,?,?,?)",
                params![uuid::Uuid::new_v4().to_string(), plugin_id, version, integrity, owner_type, owner_id, previous, requested, now.to_rfc3339()],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        drop(connection);
        self.get_installed_plugin(plugin_id, version, integrity, owner_type, owner_id)?
            .ok_or_else(|| {
                EngineError::Storage("Approved plugin disappeared from the registry.".into())
            })
    }

    pub fn set_plugin_enabled(
        &self,
        plugin_id: &str,
        version: &str,
        integrity: &str,
        owner_type: &str,
        owner_id: &str,
        enabled: bool,
    ) -> Result<InstalledPlugin, EngineError> {
        let plugin = self
            .get_installed_plugin(plugin_id, version, integrity, owner_type, owner_id)?
            .ok_or_else(|| {
                EngineError::Validation("The exact plugin version is not installed.".into())
            })?;
        if plugin.state == PluginInstallState::Revoked {
            return Err(EngineError::Validation(
                "This package version was revoked and cannot be enabled.".into(),
            ));
        }
        if enabled && plugin.requested_permissions != plugin.approved_permissions {
            return Err(EngineError::Validation(
                "Review and approve the plugin permissions before enabling it.".into(),
            ));
        }
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "UPDATE installed_plugins SET state=?,updated_at=? WHERE plugin_id=? AND version=? AND package_integrity=? AND owner_type=? AND owner_id=?",
                params![if enabled { "enabled" } else { "disabled" }, Utc::now().to_rfc3339(), plugin_id, version, integrity, owner_type, owner_id],
            )
            .map_err(storage)?;
        self.get_installed_plugin(plugin_id, version, integrity, owner_type, owner_id)?
            .ok_or_else(|| {
                EngineError::Storage("Updated plugin disappeared from the registry.".into())
            })
    }

    pub fn save_plugin_revocation(&self, revocation: &PluginRevocation) -> Result<(), EngineError> {
        if revocation.version.is_none() && revocation.package_integrity.is_none() {
            return Err(EngineError::Validation(
                "A revocation must identify an exact version or package integrity.".into(),
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO plugin_revocations(id,plugin_id,version,package_integrity,reason,security_notice_url,revoked_at) VALUES(?,?,?,?,?,?,?)",
                params![uuid::Uuid::new_v4().to_string(), revocation.plugin_id, revocation.version, revocation.package_integrity, revocation.reason, revocation.security_notice_url, revocation.revoked_at.to_rfc3339()],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "UPDATE installed_plugins SET state='revoked',updated_at=? WHERE plugin_id=? AND ((? IS NOT NULL AND version=?) OR (? IS NOT NULL AND package_integrity=?))",
                params![Utc::now().to_rfc3339(), revocation.plugin_id, revocation.version, revocation.version, revocation.package_integrity, revocation.package_integrity],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(())
    }

    pub fn list_plugin_revocations(&self) -> Result<Vec<PluginRevocation>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection
            .prepare("SELECT plugin_id,version,package_integrity,reason,security_notice_url,revoked_at FROM plugin_revocations ORDER BY revoked_at DESC")
            .map_err(storage)?;
        let values = statement
            .query_map([], |row| {
                let revoked_at: String = row.get(5)?;
                Ok(PluginRevocation {
                    plugin_id: row.get(0)?,
                    version: row.get(1)?,
                    package_integrity: row.get(2)?,
                    reason: row.get(3)?,
                    security_notice_url: row.get(4)?,
                    revoked_at: parse_time(&revoked_at),
                })
            })
            .map_err(storage)?
            .map(|row| row.map_err(storage))
            .collect();
        values
    }

    pub fn verify_workflow_plugin_pins(&self, workflow: &Workflow) -> Result<(), EngineError> {
        for node in &workflow.nodes {
            let Some(pin) = &node.plugin else { continue };
            let plugin = self
                .get_installed_plugin(
                    &pin.plugin_id,
                    &pin.plugin_version,
                    &pin.package_integrity,
                    &workflow.owner.owner_type,
                    &workflow.owner.owner_id,
                )?
                .ok_or_else(|| EngineError::Validation(format!(
                    "Node '{}' is pinned to {} {} ({}), which is not installed for this workflow owner.",
                    node.name, pin.plugin_id, pin.plugin_version, pin.package_integrity
                )))?;
            match plugin.state {
                PluginInstallState::Enabled => {}
                PluginInstallState::Revoked => {
                    return Err(EngineError::Validation(format!(
                        "Node '{}' cannot execute because {} {} was revoked.",
                        node.name, pin.plugin_id, pin.plugin_version
                    )))
                }
                PluginInstallState::Disabled => {
                    return Err(EngineError::Validation(format!(
                        "Node '{}' requires {} {}, which is installed but disabled.",
                        node.name, pin.plugin_id, pin.plugin_version
                    )))
                }
            }
            if plugin.publisher_id != pin.publisher_id {
                return Err(EngineError::Validation(format!(
                    "Node '{}' publisher pin does not match the verified package publisher.",
                    node.name
                )));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn plugin_storage_get(
        &self,
        plugin_id: &str,
        publisher_id: &str,
        owner_id: &str,
        workspace_id: &str,
        major_version: u64,
        temporary_execution_id: &str,
        key: &str,
    ) -> Result<Option<Vec<u8>>, EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT value FROM plugin_storage WHERE plugin_id=? AND publisher_id=? AND owner_id=? AND workspace_id=? AND major_version=? AND temporary_execution_id=? AND storage_key=?",
                params![plugin_id, publisher_id, owner_id, workspace_id, major_version, temporary_execution_id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn plugin_storage_put(
        &self,
        plugin_id: &str,
        publisher_id: &str,
        owner_id: &str,
        workspace_id: &str,
        major_version: u64,
        temporary_execution_id: &str,
        key: &str,
        value: &[u8],
        quota: u64,
    ) -> Result<(), EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let used: u64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(length(value)),0) FROM plugin_storage WHERE plugin_id=? AND publisher_id=? AND owner_id=? AND workspace_id=? AND major_version=? AND temporary_execution_id=?",
                params![plugin_id, publisher_id, owner_id, workspace_id, major_version, temporary_execution_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage)?
            .max(0) as u64;
        let previous: u64 = transaction
            .query_row(
                "SELECT length(value) FROM plugin_storage WHERE plugin_id=? AND publisher_id=? AND owner_id=? AND workspace_id=? AND major_version=? AND temporary_execution_id=? AND storage_key=?",
                params![plugin_id, publisher_id, owner_id, workspace_id, major_version, temporary_execution_id, key],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage)?
            .unwrap_or(0)
            .max(0) as u64;
        let next = used
            .saturating_sub(previous)
            .saturating_add(value.len() as u64);
        if next > quota {
            return Err(EngineError::Storage(format!(
                "Plugin storage quota of {quota} bytes would be exceeded."
            )));
        }
        transaction
            .execute(
                "INSERT INTO plugin_storage(plugin_id,publisher_id,owner_id,workspace_id,major_version,temporary_execution_id,storage_key,value,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(plugin_id,publisher_id,owner_id,workspace_id,major_version,temporary_execution_id,storage_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![plugin_id, publisher_id, owner_id, workspace_id, major_version, temporary_execution_id, key, value, Utc::now().to_rfc3339()],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn plugin_storage_delete(
        &self,
        plugin_id: &str,
        publisher_id: &str,
        owner_id: &str,
        workspace_id: &str,
        major_version: u64,
        temporary_execution_id: &str,
        key: &str,
    ) -> Result<(), EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "DELETE FROM plugin_storage WHERE plugin_id=? AND publisher_id=? AND owner_id=? AND workspace_id=? AND major_version=? AND temporary_execution_id=? AND storage_key=?",
                params![plugin_id, publisher_id, owner_id, workspace_id, major_version, temporary_execution_id, key],
            )
            .map_err(storage)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn plugin_storage_used_bytes(
        &self,
        plugin_id: &str,
        publisher_id: &str,
        owner_id: &str,
        workspace_id: &str,
        major_version: u64,
        temporary_execution_id: &str,
    ) -> Result<u64, EngineError> {
        let used = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT COALESCE(SUM(length(value)),0) FROM plugin_storage WHERE plugin_id=? AND publisher_id=? AND owner_id=? AND workspace_id=? AND major_version=? AND temporary_execution_id=?",
                params![plugin_id, publisher_id, owner_id, workspace_id, major_version, temporary_execution_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage)?;
        Ok(used.max(0) as u64)
    }

    pub fn clear_temporary_plugin_storage(&self, execution_id: &str) -> Result<(), EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute(
                "DELETE FROM plugin_storage WHERE temporary_execution_id=?",
                [execution_id],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn save_workflow(&self, workflow: Workflow) -> Result<Workflow, EngineError> {
        let mut workflow = migrate_workflow(workflow)?;
        let previous = self.get_workflow(&workflow.id)?;
        if let Some(old) = &previous {
            if dangerous_fingerprint(old) != dangerous_fingerprint(&workflow) {
                workflow.settings.permissions.command_execution_permitted = false;
                workflow.settings.permissions.approval_revision = None;
            }
            if browser_fingerprint(old) != browser_fingerprint(&workflow) {
                workflow.settings.permissions.browser_automation_permitted = false;
            }
            if communication_fingerprint(old) != communication_fingerprint(&workflow) {
                workflow
                    .settings
                    .permissions
                    .external_communication_permitted = false;
                workflow
                    .settings
                    .permissions
                    .communication_approval_revision = None;
            }
        } else if workflow.nodes.iter().any(|n| {
            matches!(
                n.node_type.as_str(),
                "run_command" | "code" | "javascript_code" | "python_code"
            )
        }) {
            workflow.settings.permissions.command_execution_permitted = false;
            workflow.settings.permissions.approval_revision = None;
        }
        if previous.is_none()
            && workflow
                .nodes
                .iter()
                .any(|node| is_browser_node(&node.node_type))
        {
            workflow.settings.permissions.browser_automation_permitted = false;
        }
        if previous.is_none()
            && workflow
                .nodes
                .iter()
                .any(|node| is_communication_node(&node.node_type))
        {
            workflow
                .settings
                .permissions
                .external_communication_permitted = false;
            workflow
                .settings
                .permissions
                .communication_approval_revision = None;
        }
        workflow.updated_at = Utc::now();
        let content_hash = workflow_content_hash(&workflow)?;
        if let Some(old) = &previous {
            if self.current_revision_hash(&workflow.id)?.as_deref() == Some(&content_hash) {
                return Ok(old.clone());
            }
        }
        let trigger_type = workflow
            .nodes
            .iter()
            .find(|n| n.id == workflow.trigger_node_id)
            .map(|n| n.node_type.as_str())
            .unwrap_or("unknown");
        let json = serde_json::to_string(&workflow).map_err(storage)?;
        let previous_permissions = previous
            .as_ref()
            .map(|w| serde_json::to_string(&w.settings.permissions).unwrap());
        let current_permissions =
            serde_json::to_string(&workflow.settings.permissions).map_err(storage)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let parent_revision_id: Option<String> = transaction
            .query_row(
                "SELECT revision_id FROM workflow_revision_heads WHERE workflow_id=?",
                [&workflow.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        let revision_id = Uuid::new_v4().to_string();
        let change_summary = summarize_workflow_change(previous.as_ref(), &workflow);
        transaction.execute(
            "INSERT INTO workflows(id,name,description,enabled,trigger_type,schema_version,definition_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,enabled=excluded.enabled,trigger_type=excluded.trigger_type,schema_version=excluded.schema_version,definition_json=excluded.definition_json,updated_at=excluded.updated_at",
            params![workflow.id, workflow.name, workflow.description, workflow.enabled, trigger_type, workflow.schema_version, json, workflow.created_at.to_rfc3339(), workflow.updated_at.to_rfc3339()]
        ).map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO workflow_revisions(revision_id,workflow_id,parent_revision_id,schema_version,content_hash,definition_json,change_summary,created_at) VALUES(?,?,?,?,?,?,?,?)",
                params![revision_id, workflow.id, parent_revision_id, workflow.schema_version, content_hash, json, change_summary, workflow.updated_at.to_rfc3339()],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO workflow_revision_heads(workflow_id,revision_id) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET revision_id=excluded.revision_id",
                params![workflow.id, revision_id],
            )
            .map_err(storage)?;
        if previous_permissions.as_deref() != Some(current_permissions.as_str()) {
            transaction.execute("INSERT INTO permission_audit(workflow_id,changed_at,previous_json,current_json,reason) VALUES(?,?,?,?,?)",
                params![workflow.id, Utc::now().to_rfc3339(), previous_permissions, current_permissions, "Workflow permissions changed"]
            ).map_err(storage)?;
        }
        transaction.commit().map_err(storage)?;
        Ok(workflow)
    }

    fn current_revision_hash(&self, workflow_id: &str) -> Result<Option<String>, EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT revision.content_hash FROM workflow_revision_heads head JOIN workflow_revisions revision ON revision.revision_id=head.revision_id WHERE head.workflow_id=?",
                [workflow_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)
    }

    pub fn list_workflow_revisions(
        &self,
        workflow_id: &str,
    ) -> Result<Vec<WorkflowRevisionSummary>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection
            .prepare(
                "SELECT revision.revision_id,revision.workflow_id,revision.parent_revision_id,revision.schema_version,revision.content_hash,revision.change_summary,revision.created_at,CASE WHEN head.revision_id=revision.revision_id THEN 1 ELSE 0 END FROM workflow_revisions revision LEFT JOIN workflow_revision_heads head ON head.workflow_id=revision.workflow_id WHERE revision.workflow_id=? ORDER BY revision.created_at DESC,revision.revision_id DESC",
            )
            .map_err(storage)?;
        let revisions = statement
            .query_map([workflow_id], |row| {
                let created_at: String = row.get(6)?;
                Ok(WorkflowRevisionSummary {
                    revision_id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    parent_revision_id: row.get(2)?,
                    schema_version: row.get(3)?,
                    content_hash: row.get(4)?,
                    change_summary: row.get(5)?,
                    created_at: parse_time(&created_at),
                    current: row.get::<_, i64>(7)? != 0,
                })
            })
            .map_err(storage)?
            .map(|row| row.map_err(storage))
            .collect();
        revisions
    }

    pub fn get_workflow_revision(
        &self,
        workflow_id: &str,
        revision_id: &str,
    ) -> Result<Option<Workflow>, EngineError> {
        let json: Option<String> = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT definition_json FROM workflow_revisions WHERE workflow_id=? AND revision_id=?",
                params![workflow_id, revision_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        json.map(|value| decode_workflow(&value)).transpose()
    }

    pub fn restore_workflow_revision(
        &self,
        workflow_id: &str,
        revision_id: &str,
    ) -> Result<Workflow, EngineError> {
        let mut workflow = self
            .get_workflow_revision(workflow_id, revision_id)?
            .ok_or_else(|| EngineError::Storage("Workflow revision no longer exists.".into()))?;
        workflow.updated_at = Utc::now();
        self.save_workflow(workflow)
    }

    pub fn get_workflow_state(
        &self,
        workflow_id: &str,
        key: &str,
    ) -> Result<Option<Value>, EngineError> {
        validate_state_key(key)?;
        let encoded: Option<String> = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT value_json FROM workflow_state WHERE workflow_id=? AND state_key=?",
                params![workflow_id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        encoded
            .map(|value| serde_json::from_str(&value).map_err(storage))
            .transpose()
    }

    pub fn set_workflow_states(
        &self,
        workflow_id: &str,
        values: &std::collections::HashMap<String, Value>,
    ) -> Result<(), EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        for (key, value) in values {
            validate_state_key(key)?;
            transaction
                .execute(
                    "INSERT INTO workflow_state(workflow_id,state_key,value_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(workflow_id,state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                    params![workflow_id, key, serde_json::to_string(value).map_err(storage)?, Utc::now().to_rfc3339()],
                )
                .map_err(storage)?;
        }
        transaction.commit().map_err(storage)
    }

    pub fn get_workflow(&self, id: &str) -> Result<Option<Workflow>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let json: Option<String> = connection
            .query_row(
                "SELECT definition_json FROM workflows WHERE id=?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        json.map(|value| decode_workflow(&value)).transpose()
    }

    pub fn list_workflows(&self) -> Result<Vec<WorkflowSummary>, EngineError> {
        self.list_workflows_including_archived(false)
    }

    pub fn list_workflows_including_archived(
        &self,
        include_archived: bool,
    ) -> Result<Vec<WorkflowSummary>, EngineError> {
        let workflows: Vec<(Workflow, WorkflowMetadata)> = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
            let mut statement = connection
                .prepare("SELECT w.definition_json,COALESCE(m.favorite,0),m.folder,COALESCE(m.tags_json,'[]'),m.archived_at,m.last_opened_at FROM workflows w LEFT JOIN workflow_metadata m ON m.workflow_id=w.id WHERE (?=1 OR m.archived_at IS NULL) ORDER BY w.updated_at DESC")
                .map_err(storage)?;
            let rows = statement
                .query_map([if include_archived { 1 } else { 0 }], |row| {
                    let definition = row.get::<_, String>(0)?;
                    let favorite = row.get::<_, i64>(1)? != 0;
                    let folder = row.get::<_, Option<String>>(2)?;
                    let tags_json = row.get::<_, String>(3)?;
                    let archived_at = row.get::<_, Option<String>>(4)?;
                    let last_opened_at = row.get::<_, Option<String>>(5)?;
                    Ok((
                        definition,
                        favorite,
                        folder,
                        tags_json,
                        archived_at,
                        last_opened_at,
                    ))
                })
                .map_err(storage)?;
            rows.map(|row| {
                let (definition, favorite, folder, tags_json, archived_at, last_opened_at) =
                    row.map_err(storage)?;
                Ok((
                    decode_workflow(&definition)?,
                    WorkflowMetadata {
                        favorite,
                        folder,
                        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                        archived_at: archived_at
                            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
                            .map(|value| value.with_timezone(&Utc)),
                        last_opened_at: last_opened_at
                            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
                            .map(|value| value.with_timezone(&Utc)),
                    },
                ))
            })
            .collect::<Result<_, _>>()?
        };
        workflows
            .into_iter()
            .map(|(workflow, metadata)| {
                let last_execution = self
                    .list_executions(Some(&workflow.id), 1)?
                    .into_iter()
                    .next();
                let next_run_at = self.get_next_run(&workflow.id)?;
                Ok(WorkflowSummary {
                    workflow,
                    metadata,
                    last_execution,
                    next_run_at,
                })
            })
            .collect()
    }

    pub fn update_workflow_metadata(
        &self,
        id: &str,
        patch: WorkflowMetadataPatch,
    ) -> Result<WorkflowMetadata, EngineError> {
        let current = self.get_workflow_metadata(id)?;
        let metadata = patched_workflow_metadata(current, &patch)?;
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO workflow_metadata(workflow_id,favorite,folder,tags_json,archived_at,last_opened_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET favorite=excluded.favorite,folder=excluded.folder,tags_json=excluded.tags_json,archived_at=excluded.archived_at,last_opened_at=excluded.last_opened_at",
            params![id, metadata.favorite, metadata.folder, serde_json::to_string(&metadata.tags).map_err(storage)?, metadata.archived_at.map(|value|value.to_rfc3339()), metadata.last_opened_at.map(|value|value.to_rfc3339())]
        ).map_err(storage)?;
        Ok(metadata)
    }

    pub fn batch_update_workflow_metadata(
        &self,
        ids: &[String],
        patch: WorkflowMetadataPatch,
    ) -> Result<Vec<WorkflowMetadata>, EngineError> {
        let ids = unique_workflow_ids(ids)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        for id in &ids {
            let exists = transaction
                .query_row("SELECT 1 FROM workflows WHERE id=?", [id], |_| Ok(()))
                .optional()
                .map_err(storage)?;
            if exists.is_none() {
                return Err(EngineError::Storage(format!(
                    "Workflow {id} no longer exists."
                )));
            }
        }
        let mut updated = Vec::with_capacity(ids.len());
        for id in &ids {
            let current = transaction.query_row("SELECT favorite,folder,tags_json,archived_at,last_opened_at FROM workflow_metadata WHERE workflow_id=?", [id], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?))).optional().map_err(storage)?
                .map(workflow_metadata_from_row).unwrap_or_default();
            let metadata = patched_workflow_metadata(current, &patch)?;
            transaction.execute(
                "INSERT INTO workflow_metadata(workflow_id,favorite,folder,tags_json,archived_at,last_opened_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET favorite=excluded.favorite,folder=excluded.folder,tags_json=excluded.tags_json,archived_at=excluded.archived_at,last_opened_at=excluded.last_opened_at",
                params![id, metadata.favorite, metadata.folder, serde_json::to_string(&metadata.tags).map_err(storage)?, metadata.archived_at.map(|value|value.to_rfc3339()), metadata.last_opened_at.map(|value|value.to_rfc3339())]
            ).map_err(storage)?;
            updated.push(metadata);
        }
        transaction.commit().map_err(storage)?;
        Ok(updated)
    }

    pub fn set_workflows_archived(
        &self,
        ids: &[String],
        archived: bool,
    ) -> Result<(), EngineError> {
        let ids = unique_workflow_ids(ids)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut workflows = Vec::with_capacity(ids.len());
        for id in &ids {
            let json = transaction
                .query_row(
                    "SELECT definition_json FROM workflows WHERE id=?",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(storage)?
                .ok_or_else(|| EngineError::Storage(format!("Workflow {id} no longer exists.")))?;
            workflows.push(decode_workflow(&json)?);
        }
        let changed_at = Utc::now();
        for mut workflow in workflows {
            if workflow.enabled {
                let previous = workflow.clone();
                workflow.enabled = false;
                workflow.updated_at = changed_at;
                let trigger_type = workflow
                    .nodes
                    .iter()
                    .find(|node| node.id == workflow.trigger_node_id)
                    .map(|node| node.node_type.as_str())
                    .unwrap_or("unknown");
                let json = serde_json::to_string(&workflow).map_err(storage)?;
                let content_hash = workflow_content_hash(&workflow)?;
                let parent_revision_id: Option<String> = transaction
                    .query_row(
                        "SELECT revision_id FROM workflow_revision_heads WHERE workflow_id=?",
                        [&workflow.id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(storage)?;
                let revision_id = Uuid::new_v4().to_string();
                transaction.execute("UPDATE workflows SET enabled=0,trigger_type=?,definition_json=?,updated_at=? WHERE id=?", params![trigger_type,json,changed_at.to_rfc3339(),workflow.id]).map_err(storage)?;
                transaction.execute("INSERT INTO workflow_revisions(revision_id,workflow_id,parent_revision_id,schema_version,content_hash,definition_json,change_summary,created_at) VALUES(?,?,?,?,?,?,?,?)", params![revision_id,workflow.id,parent_revision_id,workflow.schema_version,content_hash,json,summarize_workflow_change(Some(&previous),&workflow),changed_at.to_rfc3339()]).map_err(storage)?;
                transaction.execute("INSERT INTO workflow_revision_heads(workflow_id,revision_id) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET revision_id=excluded.revision_id", params![workflow.id,revision_id]).map_err(storage)?;
            }
            let archived_at = archived.then(|| changed_at.to_rfc3339());
            transaction.execute("INSERT INTO workflow_metadata(workflow_id,archived_at) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET archived_at=excluded.archived_at", params![workflow.id,archived_at]).map_err(storage)?;
        }
        transaction.commit().map_err(storage)
    }

    pub fn get_workflow_metadata(&self, id: &str) -> Result<WorkflowMetadata, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let value = connection.query_row("SELECT favorite,folder,tags_json,archived_at,last_opened_at FROM workflow_metadata WHERE workflow_id=?", [id], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?))).optional().map_err(storage)?;
        Ok(value
            .map(
                |(favorite, folder, tags_json, archived_at, last_opened_at)| WorkflowMetadata {
                    favorite: favorite != 0,
                    folder,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    archived_at: archived_at
                        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
                        .map(|value| value.with_timezone(&Utc)),
                    last_opened_at: last_opened_at
                        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
                        .map(|value| value.with_timezone(&Utc)),
                },
            )
            .unwrap_or_default())
    }

    pub fn delete_workflow(&self, id: &str) -> Result<(), EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute("DELETE FROM workflows WHERE id=?", [id])
            .map_err(storage)?;
        Ok(())
    }

    pub fn delete_workflow_with_artifacts(&self, id: &str) -> Result<Vec<String>, EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let artifacts = {
            let mut statement = transaction.prepare("SELECT screenshot_path,trace_path FROM browser_diagnostics WHERE execution_id IN (SELECT id FROM executions WHERE workflow_id=?)").map_err(storage)?;
            let rows = statement
                .query_map([id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .map_err(storage)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage)?;
            rows.into_iter()
                .flat_map(|(screenshot, trace)| screenshot.into_iter().chain(trace))
                .collect::<Vec<_>>()
        };
        transaction
            .execute("DELETE FROM workflows WHERE id=?", [id])
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(artifacts)
    }

    pub fn save_execution(&self, record: &ExecutionRecord) -> Result<(), EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        connection.execute(
            "INSERT INTO executions(id,workflow_id,workflow_version,trigger_json,status,started_at,completed_at,duration_ms,node_executions_json,error_json,skip_reason,recovered_after_crash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,node_executions_json=excluded.node_executions_json,error_json=excluded.error_json,skip_reason=excluded.skip_reason,recovered_after_crash=excluded.recovered_after_crash",
            params![record.id,record.workflow_id,record.workflow_version,serde_json::to_string(&record.trigger).map_err(storage)?,status_str(record.status),record.started_at.to_rfc3339(),record.completed_at.map(|v|v.to_rfc3339()),record.duration_ms,serde_json::to_string(&record.node_executions).map_err(storage)?,record.error.as_ref().map(serde_json::to_string).transpose().map_err(storage)?,record.skip_reason,record.recovered_after_crash]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn get_execution(&self, id: &str) -> Result<Option<ExecutionRecord>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        connection.query_row("SELECT id,workflow_id,workflow_version,trigger_json,status,started_at,completed_at,duration_ms,node_executions_json,error_json,skip_reason,recovered_after_crash FROM executions WHERE id=?", [id], parse_execution).optional().map_err(storage)
    }

    pub fn list_executions(
        &self,
        workflow_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ExecutionRecord>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        if let Some(id) = workflow_id {
            let mut statement = connection.prepare("SELECT id,workflow_id,workflow_version,trigger_json,status,started_at,completed_at,duration_ms,node_executions_json,error_json,skip_reason,recovered_after_crash FROM executions WHERE workflow_id=? ORDER BY started_at DESC, id DESC LIMIT ?").map_err(storage)?;
            let values = statement
                .query_map(params![id, limit as i64], parse_execution)
                .map_err(storage)?
                .map(|v| v.map_err(storage))
                .collect();
            values
        } else {
            let mut statement = connection.prepare("SELECT id,workflow_id,workflow_version,trigger_json,status,started_at,completed_at,duration_ms,node_executions_json,error_json,skip_reason,recovered_after_crash FROM executions ORDER BY started_at DESC, id DESC LIMIT ?").map_err(storage)?;
            let values = statement
                .query_map([limit as i64], parse_execution)
                .map_err(storage)?
                .map(|v| v.map_err(storage))
                .collect();
            values
        }
    }

    pub fn all_executions(&self) -> Result<Vec<ExecutionRecord>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection.prepare("SELECT id,workflow_id,workflow_version,trigger_json,status,started_at,completed_at,duration_ms,node_executions_json,error_json,skip_reason,recovered_after_crash FROM executions ORDER BY started_at DESC, id DESC").map_err(storage)?;
        let values = statement
            .query_map([], parse_execution)
            .map_err(storage)?
            .map(|value| value.map_err(storage))
            .collect();
        values
    }

    pub fn clear_old_executions(&self, keep: usize) -> Result<(usize, Vec<String>), EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let paths = {
            let mut statement = transaction
                .prepare(
                    "SELECT screenshot_path,trace_path FROM browser_diagnostics WHERE execution_id IN (SELECT id FROM executions WHERE id NOT IN (SELECT id FROM executions ORDER BY started_at DESC LIMIT ?))",
                )
                .map_err(storage)?;
            let rows = statement
                .query_map([keep as i64], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .map_err(storage)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage)?
                .into_iter()
                .flat_map(|(screenshot, trace)| screenshot.into_iter().chain(trace))
                .collect::<Vec<_>>();
            rows
        };
        transaction.execute(
            "DELETE FROM loop_iteration_checkpoints WHERE execution_id IN (SELECT id FROM executions WHERE id NOT IN (SELECT id FROM executions ORDER BY started_at DESC LIMIT ?))",
            [keep as i64],
        ).map_err(storage)?;
        let removed = transaction
            .execute(
                "DELETE FROM executions WHERE id NOT IN (SELECT id FROM executions ORDER BY started_at DESC LIMIT ?)",
                [keep as i64],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok((removed, paths))
    }

    pub fn delete_execution(&self, id: &str) -> Result<Vec<String>, EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let artifacts = {
            let mut statement = transaction.prepare("SELECT screenshot_path,trace_path FROM browser_diagnostics WHERE execution_id=?").map_err(storage)?;
            let rows = statement
                .query_map([id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .map_err(storage)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage)?;
            rows.into_iter()
                .flat_map(|(screenshot, trace)| screenshot.into_iter().chain(trace))
                .collect::<Vec<_>>()
        };
        transaction
            .execute(
                "DELETE FROM loop_iteration_checkpoints WHERE execution_id=?",
                [id],
            )
            .map_err(storage)?;
        transaction
            .execute("DELETE FROM executions WHERE id=?", [id])
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(artifacts)
    }

    pub fn recover_unfinished(&self) -> Result<usize, EngineError> {
        let error = serde_json::to_string(&ExecutionError {
            code: "runner_restarted".into(),
            message: "The local runner stopped before this execution completed.".into(),
            detail: None,
            suggestion: Some("Inspect the last completed node, then retry the workflow.".into()),
            line: None,
            column: None,
        })
        .unwrap();
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        connection.execute("UPDATE executions SET status='failed',completed_at=?,error_json=?,recovered_after_crash=1 WHERE status IN ('queued','running')", params![Utc::now().to_rfc3339(), error]).map_err(storage)
    }

    pub fn set_next_run(
        &self,
        workflow_id: &str,
        next: Option<DateTime<Utc>>,
    ) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO schedule_state(workflow_id,next_run_at,last_checked_at) VALUES(?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET next_run_at=excluded.next_run_at,last_checked_at=excluded.last_checked_at",
            params![workflow_id,next.map(|v|v.to_rfc3339()),Utc::now().to_rfc3339()]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn get_next_run(&self, workflow_id: &str) -> Result<Option<DateTime<Utc>>, EngineError> {
        let value: Option<String> = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT next_run_at FROM schedule_state WHERE workflow_id=?",
                [workflow_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?
            .flatten();
        value
            .map(|v| {
                DateTime::parse_from_rfc3339(&v)
                    .map(|d| d.with_timezone(&Utc))
                    .map_err(storage)
            })
            .transpose()
    }

    pub fn save_browser_profile(&self, profile: &BrowserProfile) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO browser_profiles(id,name,persistent,data_path,settings_json,created_at,last_used_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,persistent=excluded.persistent,data_path=excluded.data_path,settings_json=excluded.settings_json,last_used_at=excluded.last_used_at",
            params![profile.id, profile.name, profile.persistent, profile.data_path, serde_json::to_string(&profile.settings).map_err(storage)?, profile.created_at.to_rfc3339(), profile.last_used_at.map(|value| value.to_rfc3339())]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn list_browser_profiles(&self) -> Result<Vec<BrowserProfile>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection.prepare("SELECT id,name,persistent,data_path,settings_json,created_at,last_used_at FROM browser_profiles ORDER BY name").map_err(storage)?;
        let rows = statement
            .query_map([], |row| {
                let settings: String = row.get(4)?;
                let created: String = row.get(5)?;
                let last_used: Option<String> = row.get(6)?;
                Ok(BrowserProfile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    persistent: row.get(2)?,
                    data_path: row.get(3)?,
                    settings: serde_json::from_str(&settings).unwrap_or_default(),
                    created_at: parse_time(&created),
                    last_used_at: last_used.as_deref().map(parse_time),
                })
            })
            .map_err(storage)?;
        let values = rows.map(|row| row.map_err(storage)).collect();
        values
    }

    pub fn get_browser_profile(&self, id: &str) -> Result<Option<BrowserProfile>, EngineError> {
        Ok(self
            .list_browser_profiles()?
            .into_iter()
            .find(|profile| profile.id == id))
    }

    pub fn delete_browser_profile(&self, id: &str) -> Result<(), EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute("DELETE FROM browser_profiles WHERE id=?", [id])
            .map_err(storage)?;
        Ok(())
    }

    pub fn save_connection(&self, connection: &ConnectionMetadata) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO connections(id,provider,display_name,account_identifier,scopes_json,created_at,last_used_at,expires_at,status,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,display_name=excluded.display_name,account_identifier=excluded.account_identifier,scopes_json=excluded.scopes_json,last_used_at=excluded.last_used_at,expires_at=excluded.expires_at,status=excluded.status,metadata_json=excluded.metadata_json",
            params![connection.id, connection.provider, connection.display_name, connection.account_identifier, serde_json::to_string(&connection.scopes).map_err(storage)?, connection.created_at.to_rfc3339(), connection.last_used_at.map(|value|value.to_rfc3339()), connection.expires_at.map(|value|value.to_rfc3339()), connection_status_str(&connection.status), serde_json::to_string(&connection.metadata).map_err(storage)?]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn list_connections(&self) -> Result<Vec<ConnectionMetadata>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection.prepare("SELECT id,provider,display_name,account_identifier,scopes_json,created_at,last_used_at,expires_at,status,metadata_json FROM connections ORDER BY display_name").map_err(storage)?;
        let rows = statement.query_map([], parse_connection).map_err(storage)?;
        let values = rows.map(|row| row.map_err(storage)).collect();
        values
    }

    pub fn get_connection(&self, id: &str) -> Result<Option<ConnectionMetadata>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        connection.query_row("SELECT id,provider,display_name,account_identifier,scopes_json,created_at,last_used_at,expires_at,status,metadata_json FROM connections WHERE id=?", [id], parse_connection).optional().map_err(storage)
    }

    pub fn delete_connection(&self, id: &str) -> Result<(), EngineError> {
        self.connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .execute("DELETE FROM connections WHERE id=?", [id])
            .map_err(storage)?;
        Ok(())
    }

    pub fn save_pending_approval(&self, approval: &PendingApproval) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO pending_approvals(id,execution_id,workflow_id,node_id,action_json,status,created_at,expires_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,resolved_at=excluded.resolved_at",
            params![approval.id, approval.execution_id, approval.workflow_id, approval.node_id, serde_json::to_string(&approval.action).map_err(storage)?, approval.status, approval.created_at.to_rfc3339(), approval.expires_at.to_rfc3339(), approval.resolved_at.map(|value|value.to_rfc3339())]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn list_pending_approvals(&self) -> Result<Vec<PendingApproval>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let mut statement = connection.prepare("SELECT id,execution_id,workflow_id,node_id,action_json,status,created_at,expires_at,resolved_at FROM pending_approvals WHERE status='pending' ORDER BY created_at DESC").map_err(storage)?;
        let rows = statement
            .query_map([], |row| {
                let action: String = row.get(4)?;
                let created: String = row.get(6)?;
                let expires: String = row.get(7)?;
                let resolved: Option<String> = row.get(8)?;
                Ok(PendingApproval {
                    id: row.get(0)?,
                    execution_id: row.get(1)?,
                    workflow_id: row.get(2)?,
                    node_id: row.get(3)?,
                    action: serde_json::from_str(&action).unwrap_or_default(),
                    status: row.get(5)?,
                    created_at: parse_time(&created),
                    expires_at: parse_time(&expires),
                    resolved_at: resolved.as_deref().map(parse_time),
                })
            })
            .map_err(storage)?;
        let values = rows.map(|row| row.map_err(storage)).collect();
        values
    }

    pub fn get_pending_approval(&self, id: &str) -> Result<Option<PendingApproval>, EngineError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        connection.query_row("SELECT id,execution_id,workflow_id,node_id,action_json,status,created_at,expires_at,resolved_at FROM pending_approvals WHERE id=?", [id], |row| {
            let action:String=row.get(4)?;let created:String=row.get(6)?;let expires:String=row.get(7)?;let resolved:Option<String>=row.get(8)?;
            Ok(PendingApproval{id:row.get(0)?,execution_id:row.get(1)?,workflow_id:row.get(2)?,node_id:row.get(3)?,action:serde_json::from_str(&action).unwrap_or_default(),status:row.get(5)?,created_at:parse_time(&created),expires_at:parse_time(&expires),resolved_at:resolved.as_deref().map(parse_time)})
        }).optional().map_err(storage)
    }

    pub fn resolve_pending_approval(&self, id: &str, status: &str) -> Result<bool, EngineError> {
        if !matches!(status, "approved" | "rejected") {
            return Err(EngineError::Validation(
                "Approval status must be approved or rejected.".into(),
            ));
        }
        let changed=self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "UPDATE pending_approvals SET status=?,resolved_at=? WHERE id=? AND status='pending' AND expires_at>?",
            params![status,Utc::now().to_rfc3339(),id,Utc::now().to_rfc3339()]
        ).map_err(storage)?;
        Ok(changed == 1)
    }

    pub fn save_recording_draft(&self, draft: &RecordedWorkflowDraft) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO recorded_workflow_drafts(id,workflow_id,profile_id,status,steps_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workflow_id=excluded.workflow_id,status=excluded.status,steps_json=excluded.steps_json,updated_at=excluded.updated_at",
            params![draft.id,draft.workflow_id,draft.profile_id,draft.status,serde_json::to_string(&draft.steps).map_err(storage)?,draft.created_at.to_rfc3339(),draft.updated_at.to_rfc3339()]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn save_browser_diagnostic(
        &self,
        execution_id: &str,
        node_id: &str,
        diagnostic: &BrowserDiagnostics,
        expires_at: DateTime<Utc>,
    ) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO browser_diagnostics(id,execution_id,node_id,diagnostic_json,screenshot_path,trace_path,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
            params![uuid::Uuid::new_v4().to_string(),execution_id,node_id,serde_json::to_string(diagnostic).map_err(storage)?,diagnostic.screenshot_path,diagnostic.trace_path,Utc::now().to_rfc3339(),expires_at.to_rfc3339()]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn take_expired_browser_artifacts(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<String>, EngineError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?;
        let transaction = connection.transaction().map_err(storage)?;
        let paths = {
            let mut statement = transaction
                .prepare("SELECT screenshot_path,trace_path FROM browser_diagnostics WHERE expires_at<=?")
                .map_err(storage)?;
            let rows = statement
                .query_map([now.to_rfc3339()], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .map_err(storage)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage)?
                .into_iter()
                .flat_map(|(screenshot, trace)| screenshot.into_iter().chain(trace))
                .collect::<Vec<_>>()
        };
        transaction
            .execute(
                "DELETE FROM browser_diagnostics WHERE expires_at<=?",
                [now.to_rfc3339()],
            )
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(paths)
    }

    pub fn gmail_message_processed(
        &self,
        workflow_id: &str,
        message_id: &str,
    ) -> Result<bool, EngineError> {
        let changed = self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT OR IGNORE INTO gmail_poll_state(workflow_id,message_id,processed_at) VALUES(?,?,?)",
            params![workflow_id,message_id,Utc::now().to_rfc3339()]
        ).map_err(storage)?;
        Ok(changed == 0)
    }

    pub fn get_last_integration_poll(
        &self,
        workflow_id: &str,
    ) -> Result<Option<DateTime<Utc>>, EngineError> {
        let value: Option<String> = self
            .connection
            .lock()
            .map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?
            .query_row(
                "SELECT last_polled_at FROM integration_poll_state WHERE workflow_id=?",
                [workflow_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        Ok(value.as_deref().map(parse_time))
    }

    pub fn set_last_integration_poll(
        &self,
        workflow_id: &str,
        value: DateTime<Utc>,
    ) -> Result<(), EngineError> {
        self.connection.lock().map_err(|_| EngineError::Storage("Database lock was poisoned.".into()))?.execute(
            "INSERT INTO integration_poll_state(workflow_id,last_polled_at) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET last_polled_at=excluded.last_polled_at",
            params![workflow_id,value.to_rfc3339()]
        ).map_err(storage)?;
        Ok(())
    }

    pub fn workflows_using_reference(&self, key: &str) -> Result<Vec<String>, EngineError> {
        Ok(self
            .list_workflows()?
            .into_iter()
            .filter(|summary| {
                serde_json::to_string(&summary.workflow).is_ok_and(|json| json.contains(key))
            })
            .map(|summary| summary.workflow.id)
            .collect())
    }
}

fn dangerous_fingerprint(workflow: &Workflow) -> String {
    serde_json::to_string(
        &workflow
            .nodes
            .iter()
            .filter(|n| {
                matches!(
                    n.node_type.as_str(),
                    "run_command" | "code" | "javascript_code" | "python_code"
                )
            })
            .map(|n| (&n.id, &n.configuration))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}
fn browser_fingerprint(workflow: &Workflow) -> String {
    serde_json::to_string(
        &workflow
            .nodes
            .iter()
            .filter(|node| is_browser_node(&node.node_type))
            .map(|node| (&node.id, &node.node_type, &node.configuration))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}
fn communication_fingerprint(workflow: &Workflow) -> String {
    serde_json::to_string(
        &workflow
            .nodes
            .iter()
            .filter(|node| is_communication_node(&node.node_type))
            .map(|node| (&node.id, &node.node_type, &node.configuration))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}
fn is_browser_node(node_type: &str) -> bool {
    matches!(
        node_type,
        "open_browser"
            | "navigate"
            | "click_element"
            | "fill_field"
            | "select_option"
            | "press_key"
            | "wait_for"
            | "extract_data"
            | "screenshot"
            | "download_file"
            | "upload_file"
            | "close_browser"
    )
}
fn is_communication_node(node_type: &str) -> bool {
    matches!(
        node_type,
        "gmail_create_draft"
            | "gmail_send_email"
            | "gmail_add_label"
            | "discord_webhook"
            | "discord_embed"
            | "slack_webhook"
    )
}
fn storage(error: impl std::fmt::Display) -> EngineError {
    EngineError::Storage(error.to_string())
}
fn status_str(status: ExecutionStatus) -> &'static str {
    match status {
        ExecutionStatus::Queued => "queued",
        ExecutionStatus::Running => "running",
        ExecutionStatus::Successful => "successful",
        ExecutionStatus::SuccessfulWithWarnings => "successful_with_warnings",
        ExecutionStatus::Failed => "failed",
        ExecutionStatus::Skipped => "skipped",
        ExecutionStatus::Cancelled => "cancelled",
    }
}
fn parse_status(value: &str) -> ExecutionStatus {
    match value {
        "queued" => ExecutionStatus::Queued,
        "running" => ExecutionStatus::Running,
        "successful" => ExecutionStatus::Successful,
        "successful_with_warnings" => ExecutionStatus::SuccessfulWithWarnings,
        "skipped" => ExecutionStatus::Skipped,
        "cancelled" => ExecutionStatus::Cancelled,
        _ => ExecutionStatus::Failed,
    }
}
fn parse_execution(row: &rusqlite::Row) -> rusqlite::Result<ExecutionRecord> {
    let trigger: String = row.get(3)?;
    let status: String = row.get(4)?;
    let started: String = row.get(5)?;
    let completed: Option<String> = row.get(6)?;
    let nodes: String = row.get(8)?;
    let error: Option<String> = row.get(9)?;
    Ok(ExecutionRecord {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        workflow_version: row.get(2)?,
        trigger: serde_json::from_str(&trigger).unwrap_or_default(),
        status: parse_status(&status),
        started_at: DateTime::parse_from_rfc3339(&started)
            .unwrap()
            .with_timezone(&Utc),
        completed_at: completed.and_then(|v| {
            DateTime::parse_from_rfc3339(&v)
                .ok()
                .map(|v| v.with_timezone(&Utc))
        }),
        duration_ms: row.get(7)?,
        node_executions: serde_json::from_str(&nodes).unwrap_or_default(),
        error: error.and_then(|v| serde_json::from_str(&v).ok()),
        skip_reason: row.get(10)?,
        recovered_after_crash: row.get::<_, i64>(11)? != 0,
    })
}

fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn connection_status_str(status: &ConnectionStatus) -> &'static str {
    match status {
        ConnectionStatus::Connected => "connected",
        ConnectionStatus::Expired => "expired",
        ConnectionStatus::Revoked => "revoked",
        ConnectionStatus::Error => "error",
        ConnectionStatus::SetupRequired => "setup_required",
    }
}

fn plugin_install_state_str(state: PluginInstallState) -> &'static str {
    match state {
        PluginInstallState::Disabled => "disabled",
        PluginInstallState::Enabled => "enabled",
        PluginInstallState::Revoked => "revoked",
    }
}

fn parse_installed_plugin(row: &rusqlite::Row) -> rusqlite::Result<InstalledPlugin> {
    let state: String = row.get(9)?;
    let manifest: String = row.get(10)?;
    let requested: String = row.get(11)?;
    let approved: String = row.get(12)?;
    let installed_at: String = row.get(15)?;
    let updated_at: String = row.get(16)?;
    Ok(InstalledPlugin {
        plugin_id: row.get(0)?,
        version: row.get(1)?,
        package_integrity: row.get(2)?,
        publisher_id: row.get(3)?,
        publisher_key_id: row.get(4)?,
        publisher_public_key_pem: row.get(17)?,
        owner_type: row.get(5)?,
        owner_id: row.get(6)?,
        source: row.get(7)?,
        development: row.get(8)?,
        state: match state.as_str() {
            "enabled" => PluginInstallState::Enabled,
            "revoked" => PluginInstallState::Revoked,
            _ => PluginInstallState::Disabled,
        },
        manifest: serde_json::from_str(&manifest).unwrap_or_default(),
        requested_permissions: serde_json::from_str(&requested).unwrap_or_default(),
        approved_permissions: serde_json::from_str(&approved).unwrap_or_default(),
        update_requires_review: row.get(13)?,
        package_path: row.get(14)?,
        installed_at: parse_time(&installed_at),
        updated_at: parse_time(&updated_at),
    })
}

fn parse_connection(row: &rusqlite::Row) -> rusqlite::Result<ConnectionMetadata> {
    let scopes: String = row.get(4)?;
    let created: String = row.get(5)?;
    let last: Option<String> = row.get(6)?;
    let expires: Option<String> = row.get(7)?;
    let status: String = row.get(8)?;
    let metadata: String = row.get(9)?;
    Ok(ConnectionMetadata {
        id: row.get(0)?,
        provider: row.get(1)?,
        display_name: row.get(2)?,
        account_identifier: row.get(3)?,
        scopes: serde_json::from_str(&scopes).unwrap_or_default(),
        created_at: parse_time(&created),
        last_used_at: last.as_deref().map(parse_time),
        expires_at: expires.as_deref().map(parse_time),
        status: match status.as_str() {
            "connected" => ConnectionStatus::Connected,
            "expired" => ConnectionStatus::Expired,
            "revoked" => ConnectionStatus::Revoked,
            "error" => ConnectionStatus::Error,
            _ => ConnectionStatus::SetupRequired,
        },
        metadata: serde_json::from_str(&metadata).unwrap_or_default(),
    })
}

fn migrate_workflow(mut workflow: Workflow) -> Result<Workflow, EngineError> {
    match workflow.schema_version {
        crate::model::CURRENT_SCHEMA_VERSION => Ok(workflow),
        1 | 2 | 3 | 4 | 5 | 6 => {
            workflow.schema_version = crate::model::CURRENT_SCHEMA_VERSION;
            Ok(workflow)
        }
        version if version > crate::model::CURRENT_SCHEMA_VERSION => Err(EngineError::Validation(
            format!("Workflow schema {version} was created by a newer version of sndbox."),
        )),
        version => Err(EngineError::Validation(format!(
            "Workflow schema {version} is not supported."
        ))),
    }
}

fn decode_workflow(json: &str) -> Result<Workflow, EngineError> {
    migrate_workflow(serde_json::from_str(json).map_err(storage)?)
}

fn unique_workflow_ids(ids: &[String]) -> Result<Vec<String>, EngineError> {
    let mut seen = std::collections::HashSet::new();
    let ids = ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Err(EngineError::Storage("Choose at least one workflow.".into()));
    }
    if ids.len() > 500 {
        return Err(EngineError::Storage(
            "Bulk actions are limited to 500 workflows.".into(),
        ));
    }
    Ok(ids)
}

fn workflow_metadata_from_row(
    row: (i64, Option<String>, String, Option<String>, Option<String>),
) -> WorkflowMetadata {
    WorkflowMetadata {
        favorite: row.0 != 0,
        folder: row.1,
        tags: serde_json::from_str(&row.2).unwrap_or_default(),
        archived_at: row
            .3
            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&Utc)),
        last_opened_at: row
            .4
            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&Utc)),
    }
}

fn patched_workflow_metadata(
    current: WorkflowMetadata,
    patch: &WorkflowMetadataPatch,
) -> Result<WorkflowMetadata, EngineError> {
    let folder = match &patch.folder {
        Some(value) => value
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        None => current.folder,
    };
    if folder
        .as_ref()
        .is_some_and(|value| value.chars().count() > 64)
    {
        return Err(EngineError::Storage(
            "Folder names are limited to 64 characters.".into(),
        ));
    }
    if patch.tags.is_some() && (patch.add_tags.is_some() || patch.remove_tags.is_some()) {
        return Err(EngineError::Storage(
            "Replace tags or add/remove tags, but do not do both at once.".into(),
        ));
    }
    let mut tags = patch.tags.clone().unwrap_or(current.tags);
    for value in patch.add_tags.clone().unwrap_or_default() {
        let value = value.trim().to_string();
        if !value.is_empty()
            && !tags
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&value))
        {
            tags.push(value);
        }
    }
    let removed = patch
        .remove_tags
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .collect::<std::collections::HashSet<_>>();
    tags.retain(|value| !removed.contains(&value.to_lowercase()));
    let tags = tags
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if tags.len() > 10 || tags.iter().any(|value| value.chars().count() > 32) {
        return Err(EngineError::Storage(
            "Use at most 10 tags, each no longer than 32 characters.".into(),
        ));
    }
    Ok(WorkflowMetadata {
        favorite: patch.favorite.unwrap_or(current.favorite),
        folder,
        tags,
        archived_at: patch.archived_at.clone().unwrap_or(current.archived_at),
        last_opened_at: patch
            .last_opened_at
            .clone()
            .unwrap_or(current.last_opened_at),
    })
}

fn migrate_saved_workflows(connection: &Connection) -> Result<(), EngineError> {
    let rows: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT id, definition_json FROM workflows WHERE schema_version < ?")
            .map_err(storage)?;
        let values = statement
            .query_map([crate::model::CURRENT_SCHEMA_VERSION], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(storage)?;
        values.collect::<Result<_, _>>().map_err(storage)?
    };
    for (id, json) in rows {
        let workflow = decode_workflow(&json)?;
        connection
            .execute(
                "UPDATE workflows SET schema_version=?, definition_json=? WHERE id=?",
                params![
                    workflow.schema_version,
                    serde_json::to_string(&workflow).map_err(storage)?,
                    id
                ],
            )
            .map_err(storage)?;
    }
    Ok(())
}

fn backfill_workflow_revisions(connection: &Connection) -> Result<(), EngineError> {
    let rows: Vec<(String, String)> = {
        let mut statement = connection
            .prepare(
                "SELECT workflow.id,workflow.definition_json FROM workflows workflow LEFT JOIN workflow_revision_heads head ON head.workflow_id=workflow.id WHERE head.workflow_id IS NULL",
            )
            .map_err(storage)?;
        let values = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(storage)?
            .collect::<Result<_, _>>()
            .map_err(storage)?;
        values
    };
    for (workflow_id, definition_json) in rows {
        let workflow = decode_workflow(&definition_json)?;
        let canonical_json = serde_json::to_string(&workflow).map_err(storage)?;
        let revision_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO workflow_revisions(revision_id,workflow_id,parent_revision_id,schema_version,content_hash,definition_json,change_summary,created_at) VALUES(?,?,NULL,?,?,?,?,?)",
                params![revision_id, workflow_id, workflow.schema_version, workflow_content_hash(&workflow)?, canonical_json, "Imported existing workflow", workflow.updated_at.to_rfc3339()],
            )
            .map_err(storage)?;
        connection
            .execute(
                "INSERT INTO workflow_revision_heads(workflow_id,revision_id) VALUES(?,?)",
                params![workflow_id, revision_id],
            )
            .map_err(storage)?;
    }
    Ok(())
}

fn workflow_content_hash(workflow: &Workflow) -> Result<String, EngineError> {
    let mut value = serde_json::to_value(workflow).map_err(storage)?;
    if let Some(object) = value.as_object_mut() {
        object.remove("updatedAt");
    }
    let encoded = serde_json::to_vec(&value).map_err(storage)?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}

fn summarize_workflow_change(previous: Option<&Workflow>, current: &Workflow) -> String {
    let Some(previous) = previous else {
        return "Created workflow".into();
    };
    let mut changes = Vec::new();
    if previous.name != current.name {
        changes.push("renamed workflow");
    }
    if previous.nodes != current.nodes {
        changes.push("changed nodes");
    }
    if previous.edges != current.edges {
        changes.push("changed connections");
    }
    if previous.settings != current.settings {
        changes.push("changed settings or permissions");
    }
    if previous.enabled != current.enabled {
        changes.push(if current.enabled {
            "enabled workflow"
        } else {
            "disabled workflow"
        });
    }
    if changes.is_empty() {
        "Updated workflow details".into()
    } else {
        let summary = changes.join(", ");
        let mut characters = summary.chars();
        match characters.next() {
            Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
            None => "Updated workflow".into(),
        }
    }
}

fn validate_state_key(key: &str) -> Result<(), EngineError> {
    if key.trim().is_empty() || key.len() > 128 {
        return Err(EngineError::Storage(
            "Workflow state keys must contain 1 to 128 characters.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Position, WorkflowNode, WorkflowSettings};
    use serde_json::json;
    fn workflow() -> Workflow {
        let now = Utc::now();
        Workflow {
            id: "w".into(),
            schema_version: 1,
            owner: Default::default(),
            name: "Saved".into(),
            description: "".into(),
            enabled: true,
            trigger_node_id: "t".into(),
            nodes: vec![WorkflowNode {
                id: "t".into(),
                node_type: "manual_trigger".into(),
                version: 1,
                name: "Manual".into(),
                position: Position { x: 0., y: 0. },
                configuration: json!({}),
                disabled: false,
                input_bindings: Default::default(),
                plugin: None,
                customization: None,
                error_policy: None,
            }],
            edges: vec![],
            settings: WorkflowSettings::default(),
            created_at: now,
            updated_at: now,
        }
    }
    #[test]
    fn migrations_and_persistence_work() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sandbox.db");
        {
            let db = Database::open(&path).unwrap();
            assert_eq!(db.schema_version().unwrap(), 13);
            db.save_workflow(workflow()).unwrap();
        }
        let reopened = Database::open(&path).unwrap();
        let saved = reopened.get_workflow("w").unwrap().unwrap();
        assert_eq!(saved.name, "Saved");
        assert_eq!(saved.schema_version, crate::model::CURRENT_SCHEMA_VERSION);
        assert!(!saved.settings.permissions.browser_automation_permitted);
    }

    #[test]
    fn workflow_schema_four_and_five_migrate_deterministically_to_six() {
        for version in [4, 5] {
            let mut legacy = workflow();
            legacy.schema_version = version;
            legacy.description = "unchanged".into();
            let migrated = migrate_workflow(legacy).unwrap();
            assert_eq!(
                migrated.schema_version,
                crate::model::CURRENT_SCHEMA_VERSION
            );
            assert_eq!(migrated.description, "unchanged");
            assert_eq!(migrated.nodes.len(), 1);
        }
        let mut raw = serde_json::to_value(workflow()).unwrap();
        raw["schemaVersion"] = json!(4);
        raw["settings"]
            .as_object_mut()
            .unwrap()
            .remove("collectionLimits");
        raw["settings"]
            .as_object_mut()
            .unwrap()
            .remove("expressionLanguageVersion");
        let migrated = decode_workflow(&serde_json::to_string(&raw).unwrap()).unwrap();
        assert_eq!(
            migrated.settings.collection_limits,
            crate::CollectionLimits::default()
        );
        assert_eq!(migrated.settings.expression_language_version, 1);
    }

    #[test]
    fn loop_iteration_checkpoints_round_trip_in_iteration_order() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("loop.db")).unwrap();
        db.save_loop_iteration_checkpoint(
            "execution",
            "loop",
            "00000001",
            2,
            "active",
            "sha256:b",
            &json!({"inputItemCount":1}),
        )
        .unwrap();
        db.save_loop_iteration_checkpoint(
            "execution",
            "loop",
            "00000001",
            2,
            "failed",
            "sha256:b",
            &json!({"error":"handled"}),
        )
        .unwrap();
        db.save_loop_iteration_checkpoint(
            "execution",
            "loop",
            "00000000",
            1,
            "completed",
            "sha256:a",
            &json!({"items":[1]}),
        )
        .unwrap();
        let checkpoints = db.loop_iteration_checkpoints("execution", "loop").unwrap();
        assert_eq!(checkpoints.len(), 2);
        assert_eq!(checkpoints[0].0, "00000000");
        assert_eq!(checkpoints[1].1, 2);
        assert_eq!(checkpoints[1].2, "failed");
    }

    #[test]
    fn migrates_every_supported_database_version_to_thirteen() {
        let migrations = [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_schedule_state.sql"),
            include_str!("../migrations/003_browser_integrations.sql"),
            include_str!("../migrations/004_integration_polling.sql"),
            include_str!("../migrations/005_plugin_installations.sql"),
            include_str!("../migrations/006_plugin_execution.sql"),
            include_str!("../migrations/007_runner_command_receipts.sql"),
            include_str!("../migrations/008_workflow_metadata.sql"),
            include_str!("../migrations/009_workflow_revisions_and_state.sql"),
            include_str!("../migrations/010_first_party_integrations.sql"),
            include_str!("../migrations/011_poll_backoff.sql"),
            include_str!("../migrations/012_code_expressions.sql"),
        ];
        for version in 1..=12 {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(format!("v{version}.db"));
            {
                let connection = Connection::open(&path).unwrap();
                connection
                    .pragma_update(None, "foreign_keys", "ON")
                    .unwrap();
                for migration in migrations.iter().take(version) {
                    connection.execute_batch(migration).unwrap();
                }
            }
            let upgraded = Database::open(&path).unwrap();
            assert_eq!(
                upgraded.schema_version().unwrap(),
                13,
                "failed migration from v{version}"
            );
        }
    }

    #[test]
    fn file_grants_are_one_time_and_poll_checkpoints_are_durable() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();

        let grant = db
            .create_file_grant(
                "C:/workflow/input.bin",
                4_096,
                Utc::now() + chrono::Duration::minutes(5),
            )
            .unwrap();
        assert_eq!(
            db.resolve_file_grant(&grant).unwrap(),
            Some(("C:/workflow/input.bin".into(), 4_096))
        );
        assert!(db.consume_file_grant(&grant).unwrap());
        assert!(!db.consume_file_grant(&grant).unwrap());
        assert!(db.resolve_file_grant(&grant).unwrap().is_none());

        let event_keys = vec!["event-1".to_string(), "event-2".to_string()];
        let checkpoint = json!({"pageToken":"next"});
        let next_poll = Utc::now() + chrono::Duration::minutes(2);
        let accepted = db
            .save_poll_checkpoint(
                "w",
                "t",
                "runner",
                "connection",
                "com.sndbox.github",
                "1.0.0",
                &checkpoint,
                true,
                next_poll,
                &event_keys,
            )
            .unwrap();
        assert_eq!(accepted, event_keys);
        assert!(db
            .save_poll_checkpoint(
                "w",
                "t",
                "runner",
                "connection",
                "com.sndbox.github",
                "1.0.0",
                &checkpoint,
                true,
                next_poll,
                &event_keys,
            )
            .unwrap()
            .is_empty());

        let state = db
            .poll_cursor(
                "w",
                "t",
                "runner",
                "connection",
                "com.sndbox.github",
                "1.0.0",
            )
            .unwrap()
            .unwrap();
        assert_eq!(state.0, checkpoint);
        assert!(state.1);
        assert_eq!(state.3, 0);

        db.save_poll_failure(
            "w",
            "t",
            "runner",
            "connection",
            "com.sndbox.github",
            "1.0.0",
            next_poll,
            "rate limited; retry after 120",
        )
        .unwrap();
        assert_eq!(
            db.poll_cursor(
                "w",
                "t",
                "runner",
                "connection",
                "com.sndbox.github",
                "1.0.0",
            )
            .unwrap()
            .unwrap()
            .3,
            1
        );
    }

    #[test]
    fn workflow_revisions_are_immutable_and_restore_creates_a_new_head() {
        let db = Database::in_memory().unwrap();
        let first = db.save_workflow(workflow()).unwrap();
        let initial = db.list_workflow_revisions("w").unwrap();
        assert_eq!(initial.len(), 1);
        let initial_revision = initial[0].revision_id.clone();

        let mut changed = first;
        changed.name = "Changed".into();
        db.save_workflow(changed).unwrap();
        let changed_revisions = db.list_workflow_revisions("w").unwrap();
        assert_eq!(changed_revisions.len(), 2);
        assert!(changed_revisions[0].current);

        let restored = db
            .restore_workflow_revision("w", &initial_revision)
            .unwrap();
        assert_eq!(restored.name, "Saved");
        let restored_revisions = db.list_workflow_revisions("w").unwrap();
        assert_eq!(restored_revisions.len(), 3);
        assert!(restored_revisions[0].current);
        assert_eq!(
            restored_revisions[0].parent_revision_id.as_deref(),
            Some(changed_revisions[0].revision_id.as_str())
        );
    }

    #[test]
    fn workflow_state_is_scoped_and_replaced_atomically() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        db.set_workflow_states(
            "w",
            &std::collections::HashMap::from([("heading".into(), json!("First"))]),
        )
        .unwrap();
        assert_eq!(
            db.get_workflow_state("w", "heading").unwrap(),
            Some(json!("First"))
        );
        db.set_workflow_states(
            "w",
            &std::collections::HashMap::from([("heading".into(), json!("Second"))]),
        )
        .unwrap();
        assert_eq!(
            db.get_workflow_state("w", "heading").unwrap(),
            Some(json!("Second"))
        );
    }

    #[test]
    fn workflow_metadata_defaults_validates_and_hides_archived_rows() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        let listed = db.list_workflows().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].metadata, WorkflowMetadata::default());
        let updated = db
            .update_workflow_metadata(
                "w",
                WorkflowMetadataPatch {
                    favorite: Some(true),
                    folder: Some(Some("  Operations  ".into())),
                    tags: Some(vec![" daily ".into(), "reports".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(updated.favorite);
        assert_eq!(updated.folder.as_deref(), Some("Operations"));
        assert_eq!(updated.tags, vec!["daily", "reports"]);
        assert!(db
            .update_workflow_metadata(
                "w",
                WorkflowMetadataPatch {
                    tags: Some((0..11).map(|value| format!("tag-{value}")).collect()),
                    ..Default::default()
                }
            )
            .is_err());
        db.update_workflow_metadata(
            "w",
            WorkflowMetadataPatch {
                archived_at: Some(Some(Utc::now())),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(db.list_workflows().unwrap().is_empty());
        assert_eq!(db.list_workflows_including_archived(true).unwrap().len(), 1);
    }

    #[test]
    fn bulk_metadata_rejects_unknown_ids_before_changing_any_workflow() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        let result = db.batch_update_workflow_metadata(
            &["w".into(), "missing".into()],
            WorkflowMetadataPatch {
                favorite: Some(true),
                ..Default::default()
            },
        );
        assert!(result.is_err());
        assert!(!db.get_workflow_metadata("w").unwrap().favorite);
    }

    #[test]
    fn bulk_archive_is_atomic_and_disables_active_schedules() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        let mut second = workflow();
        second.id = "w-2".into();
        second.name = "Second".into();
        db.save_workflow(second).unwrap();

        assert!(db
            .set_workflows_archived(&["w".into(), "missing".into()], true)
            .is_err());
        assert!(db.get_workflow("w").unwrap().unwrap().enabled);
        assert!(db
            .get_workflow_metadata("w")
            .unwrap()
            .archived_at
            .is_none());

        db.set_workflows_archived(&["w".into(), "w-2".into()], true)
            .unwrap();
        for id in ["w", "w-2"] {
            assert!(!db.get_workflow(id).unwrap().unwrap().enabled);
            assert!(db
                .get_workflow_metadata(id)
                .unwrap()
                .archived_at
                .is_some());
        }
    }

    #[test]
    fn plugin_storage_enforces_quota_and_owner_isolation() {
        let db = Database::in_memory().unwrap();
        db.plugin_storage_put("plugin", "publisher", "alice", "", 1, "", "key", b"1234", 4)
            .unwrap();
        assert_eq!(
            db.plugin_storage_get("plugin", "publisher", "alice", "", 1, "", "key")
                .unwrap(),
            Some(b"1234".to_vec())
        );
        assert_eq!(
            db.plugin_storage_get("plugin", "publisher", "bob", "", 1, "", "key")
                .unwrap(),
            None
        );
        assert!(db
            .plugin_storage_put("plugin", "publisher", "alice", "", 1, "", "other", b"x", 4)
            .unwrap_err()
            .to_string()
            .contains("quota"));
        db.plugin_storage_put(
            "plugin",
            "publisher",
            "alice",
            "",
            1,
            "run-1",
            "temp",
            b"x",
            4,
        )
        .unwrap();
        db.clear_temporary_plugin_storage("run-1").unwrap();
        assert_eq!(
            db.plugin_storage_used_bytes("plugin", "publisher", "alice", "", 1, "run-1")
                .unwrap(),
            0
        );
    }

    #[test]
    fn remote_command_claim_is_atomic_and_idempotent() {
        let db = Database::in_memory().unwrap();
        let expiry = Utc::now() + chrono::Duration::minutes(5);
        assert!(db
            .claim_remote_command(
                "command-1",
                "runner-1",
                "workspace-1",
                "idempotency-key-0001",
                expiry
            )
            .unwrap());
        assert!(!db
            .claim_remote_command(
                "command-2",
                "runner-1",
                "workspace-1",
                "idempotency-key-0001",
                expiry
            )
            .unwrap());
        db.complete_remote_command("command-1", "completed")
            .unwrap();
        assert_eq!(
            db.remote_command_status("command-1").unwrap().as_deref(),
            Some("completed")
        );
        assert_eq!(db.remote_command_status("missing").unwrap(), None);
    }
    #[test]
    fn recovers_running_records() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        let now = Utc::now();
        let record = ExecutionRecord {
            id: "e".into(),
            workflow_id: "w".into(),
            workflow_version: 1,
            trigger: json!({}),
            status: ExecutionStatus::Running,
            started_at: now,
            completed_at: None,
            duration_ms: None,
            node_executions: vec![],
            error: None,
            skip_reason: None,
            recovered_after_crash: false,
        };
        db.save_execution(&record).unwrap();
        assert_eq!(db.recover_unfinished().unwrap(), 1);
        assert!(
            db.get_execution("e")
                .unwrap()
                .unwrap()
                .recovered_after_crash
        );
    }

    #[test]
    fn expires_browser_diagnostics_and_returns_owned_artifacts() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        let now = Utc::now();
        let record = ExecutionRecord {
            id: "browser-run".into(),
            workflow_id: "w".into(),
            workflow_version: 2,
            trigger: json!({}),
            status: ExecutionStatus::Failed,
            started_at: now,
            completed_at: Some(now),
            duration_ms: Some(1),
            node_executions: vec![],
            error: None,
            skip_reason: None,
            recovered_after_crash: false,
        };
        db.save_execution(&record).unwrap();
        let diagnostic = BrowserDiagnostics {
            screenshot_path: Some("C:/app/artifacts/failure.png".into()),
            trace_path: Some("C:/app/artifacts/trace.zip".into()),
            ..BrowserDiagnostics::default()
        };
        db.save_browser_diagnostic(
            "browser-run",
            "browser",
            &diagnostic,
            now - chrono::Duration::seconds(1),
        )
        .unwrap();
        let paths = db.take_expired_browser_artifacts(now).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().any(|path| path.ends_with("failure.png")));
        assert!(db.take_expired_browser_artifacts(now).unwrap().is_empty());
    }

    #[test]
    fn clearing_history_returns_artifacts_for_removed_executions_only() {
        let db = Database::in_memory().unwrap();
        db.save_workflow(workflow()).unwrap();
        let now = Utc::now();
        for (id, started_at) in [
            ("old-browser-run", now - chrono::Duration::minutes(1)),
            ("latest-browser-run", now),
        ] {
            db.save_execution(&ExecutionRecord {
                id: id.into(),
                workflow_id: "w".into(),
                workflow_version: 2,
                trigger: json!({}),
                status: ExecutionStatus::Successful,
                started_at,
                completed_at: Some(started_at),
                duration_ms: Some(1),
                node_executions: vec![],
                error: None,
                skip_reason: None,
                recovered_after_crash: false,
            })
            .unwrap();
            db.save_browser_diagnostic(
                id,
                "browser",
                &BrowserDiagnostics {
                    screenshot_path: Some(format!("C:/app/artifacts/{id}.png")),
                    ..BrowserDiagnostics::default()
                },
                now + chrono::Duration::days(1),
            )
            .unwrap();
        }

        let (removed, paths) = db.clear_old_executions(1).unwrap();

        assert_eq!(removed, 1);
        assert_eq!(paths, ["C:/app/artifacts/old-browser-run.png"]);
        assert!(db.get_execution("old-browser-run").unwrap().is_none());
        assert!(db.get_execution("latest-browser-run").unwrap().is_some());
    }
}
