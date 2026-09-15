use crate::credential_vault::CredentialVault;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use rand::RngCore;
use sandbox_engine::Workflow;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const SYNC_ROOT_KEY_VAULT_ID: &str = "workflow-sync-root-key-v1";
const KEY_VERSION: u32 = 1;
const NONCE_BYTES: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncEncryption {
    pub algorithm: String,
    pub key_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncPluginRequirement {
    pub plugin_id: String,
    pub version: String,
    pub package_integrity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSearchableMetadata {
    pub name: String,
    pub folder_id: Option<String>,
    pub required_plugins: Vec<SyncPluginRequirement>,
    pub permission_requirements: Vec<String>,
    pub runner_policy: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedWorkflowRevision {
    pub workflow_id: String,
    pub revision_id: String,
    pub parent_revision_id: Option<String>,
    pub schema_version: u32,
    pub content_hash: String,
    pub editor_device_id: String,
    pub updated_at: DateTime<Utc>,
    pub sync_state: String,
    pub encryption: SyncEncryption,
    pub encrypted_payload: String,
    pub payload_key_envelope: String,
    pub searchable_metadata: SyncSearchableMetadata,
}

#[derive(Clone)]
pub struct WorkflowSyncCrypto {
    vault: Arc<dyn CredentialVault>,
}

impl WorkflowSyncCrypto {
    pub fn new(vault: Arc<dyn CredentialVault>) -> Self {
        Self { vault }
    }

    pub fn encrypt(
        &self,
        workflow: &Workflow,
        parent_revision_id: Option<String>,
        editor_device_id: String,
    ) -> Result<EncryptedWorkflowRevision, String> {
        Uuid::parse_str(&workflow.id)
            .map_err(|_| "Only UUID workflow IDs can be synchronised.".to_string())?;
        Uuid::parse_str(&editor_device_id)
            .map_err(|_| "Sync editor device ID must be a UUID.".to_string())?;
        if let Some(parent) = &parent_revision_id {
            Uuid::parse_str(parent)
                .map_err(|_| "Parent revision ID must be a UUID.".to_string())?;
        }
        let plaintext = Zeroizing::new(
            serde_json::to_vec(workflow)
                .map_err(|error| format!("Workflow could not be encoded for sync: {error}"))?,
        );
        let content_hash = format!("sha256:{}", hex(&Sha256::digest(plaintext.as_slice())));
        let revision_id = Uuid::new_v4().to_string();
        let updated_at = Utc::now();
        let payload_aad = payload_aad(
            &workflow.id,
            &revision_id,
            parent_revision_id.as_deref(),
            workflow.schema_version,
            &content_hash,
        );
        let mut data_key = [0_u8; 32];
        rand::rng().fill_bytes(&mut data_key);
        let encrypted_payload =
            encrypt_blob(&data_key, plaintext.as_slice(), payload_aad.as_bytes())?;
        let mut root_key = self.load_or_create_root_key()?;
        let key_aad = format!("sandbox-sync-key-v1:{}:{revision_id}", workflow.id);
        let payload_key_envelope = encrypt_blob(&root_key, &data_key, key_aad.as_bytes())?;
        data_key.zeroize();
        root_key.zeroize();

        let mut required_plugins = workflow
            .nodes
            .iter()
            .filter_map(|node| node.plugin.as_ref())
            .map(|pin| SyncPluginRequirement {
                plugin_id: pin.plugin_id.clone(),
                version: pin.plugin_version.clone(),
                package_integrity: pin.package_integrity.clone(),
            })
            .collect::<Vec<_>>();
        required_plugins.sort_by(|left, right| {
            (&left.plugin_id, &left.version, &left.package_integrity).cmp(&(
                &right.plugin_id,
                &right.version,
                &right.package_integrity,
            ))
        });
        required_plugins.dedup_by(|left, right| left == right);
        let mut permission_requirements = workflow
            .settings
            .permissions
            .approved_network_domains
            .iter()
            .map(|domain| format!("network:{domain}"))
            .collect::<Vec<_>>();
        if workflow.settings.permissions.command_execution_permitted {
            permission_requirements.push("command_execution".into());
        }
        if workflow.settings.permissions.browser_automation_permitted {
            permission_requirements.push("browser_automation".into());
        }
        if workflow
            .settings
            .permissions
            .external_communication_permitted
        {
            permission_requirements.push("external_communication".into());
        }
        permission_requirements.sort();
        permission_requirements.dedup();
        Ok(EncryptedWorkflowRevision {
            workflow_id: workflow.id.clone(),
            revision_id,
            parent_revision_id,
            schema_version: workflow.schema_version,
            content_hash,
            editor_device_id,
            updated_at,
            sync_state: "local".into(),
            encryption: SyncEncryption {
                algorithm: "aes-256-gcm".into(),
                key_version: KEY_VERSION,
            },
            encrypted_payload,
            payload_key_envelope,
            searchable_metadata: SyncSearchableMetadata {
                name: workflow.name.clone(),
                folder_id: None,
                required_plugins,
                permission_requirements,
                runner_policy: serde_json::json!({"mode":"manual_runner_selection"}),
            },
        })
    }

    pub fn decrypt(&self, revision: &EncryptedWorkflowRevision) -> Result<Workflow, String> {
        if revision.encryption.algorithm != "aes-256-gcm"
            || revision.encryption.key_version != KEY_VERSION
        {
            return Err("The workflow revision uses an unsupported encryption format.".into());
        }
        let root_key = self.load_root_key()?;
        let key_aad = format!(
            "sandbox-sync-key-v1:{}:{}",
            revision.workflow_id, revision.revision_id
        );
        let mut data_key = Zeroizing::new(decrypt_blob(
            &root_key,
            &revision.payload_key_envelope,
            key_aad.as_bytes(),
        )?);
        if data_key.len() != 32 {
            return Err("The workflow data-key envelope is corrupt.".into());
        }
        let payload_aad = payload_aad(
            &revision.workflow_id,
            &revision.revision_id,
            revision.parent_revision_id.as_deref(),
            revision.schema_version,
            &revision.content_hash,
        );
        let plaintext = Zeroizing::new(decrypt_blob(
            data_key.as_slice(),
            &revision.encrypted_payload,
            payload_aad.as_bytes(),
        )?);
        data_key.zeroize();
        let calculated = format!("sha256:{}", hex(&Sha256::digest(plaintext.as_slice())));
        if calculated != revision.content_hash {
            return Err("The decrypted workflow content hash does not match the revision.".into());
        }
        let workflow: Workflow = serde_json::from_slice(plaintext.as_slice())
            .map_err(|_| "The decrypted workflow definition is invalid.".to_string())?;
        if workflow.id != revision.workflow_id || workflow.schema_version != revision.schema_version
        {
            return Err(
                "The decrypted workflow identity does not match the revision envelope.".into(),
            );
        }
        Ok(workflow)
    }

    fn load_or_create_root_key(&self) -> Result<[u8; 32], String> {
        match self.load_root_key() {
            Ok(key) => Ok(key),
            Err(_) => {
                let mut key = [0_u8; 32];
                rand::rng().fill_bytes(&mut key);
                self.vault.put(
                    SYNC_ROOT_KEY_VAULT_ID,
                    &serde_json::json!({"keyVersion":KEY_VERSION,"key":BASE64.encode(key)}),
                )?;
                Ok(key)
            }
        }
    }

    fn load_root_key(&self) -> Result<[u8; 32], String> {
        let value = self.vault.get(SYNC_ROOT_KEY_VAULT_ID)?;
        let key_version = value
            .get("keyVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "The workflow sync key version is missing.".to_string())?;
        if key_version != KEY_VERSION as u64 {
            return Err("The workflow sync root-key version is unsupported.".into());
        }
        let encoded = value
            .get("key")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "The workflow sync root key is missing.".to_string())?;
        let mut decoded = Zeroizing::new(
            BASE64
                .decode(encoded)
                .map_err(|_| "The workflow sync root key is corrupt.".to_string())?,
        );
        let key: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| "The workflow sync root key has an invalid length.".to_string())?;
        decoded.zeroize();
        Ok(key)
    }
}

fn encrypt_blob(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Workflow encryption key has an invalid length.".to_string())?;
    let mut nonce = [0_u8; NONCE_BYTES];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Workflow encryption failed.".to_string())?;
    let mut blob = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(blob))
}

fn decrypt_blob(key: &[u8], encoded: &str, aad: &[u8]) -> Result<Vec<u8>, String> {
    let blob = BASE64
        .decode(encoded)
        .map_err(|_| "Encrypted workflow data is not valid base64.".to_string())?;
    if blob.len() <= NONCE_BYTES {
        return Err("Encrypted workflow data is truncated.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "Workflow decryption key has an invalid length.".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(&blob[..NONCE_BYTES]),
            Payload {
                msg: &blob[NONCE_BYTES..],
                aad,
            },
        )
        .map_err(|_| "Workflow decryption failed authentication.".to_string())
}

fn payload_aad(
    workflow_id: &str,
    revision_id: &str,
    parent_revision_id: Option<&str>,
    schema_version: u32,
    content_hash: &str,
) -> String {
    format!(
        "sandbox-sync-payload-v1:{workflow_id}:{revision_id}:{}:{schema_version}:{content_hash}",
        parent_revision_id.unwrap_or("root")
    )
}

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_vault::CredentialVault;
    use parking_lot::Mutex;
    use sandbox_engine::{
        PermissionSummary, Position, WorkflowNode, WorkflowOwner, WorkflowSettings,
        CURRENT_SCHEMA_VERSION,
    };
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryVault(Mutex<HashMap<String, serde_json::Value>>);
    impl CredentialVault for MemoryVault {
        fn put(&self, id: &str, value: &serde_json::Value) -> Result<(), String> {
            self.0.lock().insert(id.into(), value.clone());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<serde_json::Value, String> {
            self.0
                .lock()
                .get(id)
                .cloned()
                .ok_or_else(|| "missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().remove(id);
            Ok(())
        }
        fn exists(&self, id: &str) -> Result<bool, String> {
            Ok(self.0.lock().contains_key(id))
        }
    }

    fn workflow() -> Workflow {
        let now = Utc::now();
        Workflow {
            id: Uuid::new_v4().to_string(),
            schema_version: CURRENT_SCHEMA_VERSION,
            owner: WorkflowOwner::default(),
            name: "Private sync".into(),
            description: "The service must not see this.".into(),
            enabled: false,
            trigger_node_id: "trigger".into(),
            nodes: vec![WorkflowNode {
                id: "trigger".into(),
                node_type: "manual_trigger".into(),
                version: 1,
                name: "Manual".into(),
                position: Position { x: 0.0, y: 0.0 },
                configuration: serde_json::json!({"localOnly":"secret-value"}),
                disabled: false,
                input_bindings: Default::default(),
                plugin: None,
                customization: None,
                error_policy: None,
            }],
            edges: vec![],
            settings: WorkflowSettings {
                permissions: PermissionSummary {
                    approved_network_domains: vec!["api.example.com".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn encrypts_payload_separately_from_auth_and_round_trips() {
        let crypto = WorkflowSyncCrypto::new(Arc::new(MemoryVault::default()));
        let workflow = workflow();
        let revision = crypto
            .encrypt(&workflow, None, Uuid::new_v4().to_string())
            .unwrap();
        assert!(!revision.encrypted_payload.contains("secret-value"));
        assert_ne!(revision.encrypted_payload, revision.payload_key_envelope);
        assert_eq!(crypto.decrypt(&revision).unwrap(), workflow);
    }

    #[test]
    fn preserves_both_revisions_and_rejects_ciphertext_or_identity_tampering() {
        let crypto = WorkflowSyncCrypto::new(Arc::new(MemoryVault::default()));
        let workflow = workflow();
        let parent = Uuid::new_v4().to_string();
        let first = crypto
            .encrypt(&workflow, Some(parent.clone()), Uuid::new_v4().to_string())
            .unwrap();
        let second = crypto
            .encrypt(&workflow, Some(parent), Uuid::new_v4().to_string())
            .unwrap();
        assert_ne!(first.revision_id, second.revision_id);
        assert_ne!(first.encrypted_payload, second.encrypted_payload);
        let mut tampered = first.clone();
        tampered.workflow_id = Uuid::new_v4().to_string();
        assert!(crypto.decrypt(&tampered).is_err());
        let mut tampered = second;
        tampered.encrypted_payload.replace_range(20..21, "A");
        assert!(crypto.decrypt(&tampered).is_err());
    }
}
