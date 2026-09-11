use crate::credential_vault::CredentialVault;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const INVITE_PREFIX: &str = "sndbox-collab-v1.";
const KEY_VERSION: u32 = 1;
const NONCE_BYTES: usize = 12;
const MAX_OPERATION_BYTES: usize = 1024 * 1024;
const MAX_PRESENCE_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub struct CollaborationCrypto {
    vault: Arc<dyn CredentialVault>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CollaborationInvite {
    pub(crate) version: u32,
    pub(crate) workspace_id: String,
    pub(crate) workflow_id: String,
    pub(crate) session_id: String,
    pub(crate) key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationSession {
    pub session_id: String,
    pub workspace_id: String,
    pub workflow_id: String,
    pub latest_sequence: u64,
    pub joined_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedCollaborationOperation {
    pub session_id: String,
    pub sequence: u64,
    pub operation_id: String,
    pub workflow_id: String,
    pub actor_account_id: String,
    pub base_sequence: u64,
    pub client_sequence: u64,
    pub encrypted_payload: String,
    pub payload_hash: String,
    pub created_at: DateTime<Utc>,
    pub accepted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedCollaborationOperation {
    pub session_id: String,
    pub sequence: u64,
    pub operation_id: String,
    pub workflow_id: String,
    pub actor_account_id: String,
    pub base_sequence: u64,
    pub client_sequence: u64,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
    pub accepted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedCollaborationPresence {
    pub account_id: String,
    pub device_id: String,
    pub display_name: String,
    pub color: String,
    pub encrypted_presence: String,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedCollaborationPresence {
    pub account_id: String,
    pub device_id: String,
    pub display_name: String,
    pub color: String,
    pub payload: Value,
    pub last_seen_at: DateTime<Utc>,
}

impl CollaborationCrypto {
    pub fn new(vault: Arc<dyn CredentialVault>) -> Self {
        Self { vault }
    }

    pub fn create_invite(
        &self,
        workspace_id: &str,
        workflow_id: &str,
        session_id: &str,
    ) -> Result<String, String> {
        validate_identifiers(workspace_id, workflow_id, session_id)?;
        let mut key = [0_u8; 32];
        rand::rng().fill_bytes(&mut key);
        self.store_key(session_id, &key)?;
        let invite = CollaborationInvite {
            version: KEY_VERSION,
            workspace_id: workspace_id.into(),
            workflow_id: workflow_id.into(),
            session_id: session_id.into(),
            key: BASE64.encode(key),
        };
        key.zeroize();
        let encoded = serde_json::to_vec(&invite)
            .map_err(|_| "The collaboration invite could not be encoded.".to_string())?;
        Ok(format!(
            "{INVITE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(encoded)
        ))
    }

    pub(crate) fn inspect_invite(&self, code: &str) -> Result<CollaborationInvite, String> {
        if code.len() > 2_048 || !code.starts_with(INVITE_PREFIX) {
            return Err("This is not a supported sndbox collaboration invite.".into());
        }
        let encoded = &code[INVITE_PREFIX.len()..];
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "The collaboration invite is malformed.".to_string())?;
        let invite: CollaborationInvite = serde_json::from_slice(&decoded)
            .map_err(|_| "The collaboration invite is malformed.".to_string())?;
        if invite.version != KEY_VERSION {
            return Err("The collaboration invite uses an unsupported encryption version.".into());
        }
        validate_identifiers(
            &invite.workspace_id,
            &invite.workflow_id,
            &invite.session_id,
        )?;
        decode_key(&invite.key)?;
        Ok(invite)
    }

    pub(crate) fn accept_invite(&self, invite: &CollaborationInvite) -> Result<(), String> {
        let mut key = decode_key(&invite.key)?;
        let result = self.store_key(&invite.session_id, &key);
        key.zeroize();
        result
    }

    pub fn encrypt_operation(
        &self,
        workspace_id: &str,
        workflow_id: &str,
        session_id: &str,
        operation_id: &str,
        value: &Value,
    ) -> Result<(String, String), String> {
        validate_identifiers(workspace_id, workflow_id, session_id)?;
        validate_uuid(operation_id, "Collaboration operation")?;
        let plaintext = encode_value(value, MAX_OPERATION_BYTES, "Collaboration operation")?;
        let key = self.load_key(session_id)?;
        let aad = format!(
            "sndbox-collaboration-operation-v1:{workspace_id}:{workflow_id}:{session_id}:{operation_id}"
        );
        let encrypted = encrypt_blob(key.as_ref(), plaintext.as_slice(), aad.as_bytes())?;
        let hash = payload_hash(&encrypted)?;
        Ok((encrypted, hash))
    }

    pub fn decrypt_operation(
        &self,
        workspace_id: &str,
        workflow_id: &str,
        session_id: &str,
        operation: EncryptedCollaborationOperation,
    ) -> Result<DecryptedCollaborationOperation, String> {
        if operation.session_id != session_id || operation.workflow_id != workflow_id {
            return Err("A collaboration operation was returned for a different session.".into());
        }
        validate_identifiers(workspace_id, workflow_id, session_id)?;
        validate_uuid(&operation.operation_id, "Collaboration operation")?;
        if payload_hash(&operation.encrypted_payload)? != operation.payload_hash {
            return Err("A collaboration operation failed integrity validation.".into());
        }
        let key = self.load_key(session_id)?;
        let aad = format!(
            "sndbox-collaboration-operation-v1:{workspace_id}:{workflow_id}:{session_id}:{}",
            operation.operation_id
        );
        let plaintext = decrypt_blob(key.as_ref(), &operation.encrypted_payload, aad.as_bytes())?;
        if plaintext.len() > MAX_OPERATION_BYTES {
            return Err("The decrypted collaboration operation exceeds the 1 MB limit.".into());
        }
        let payload = serde_json::from_slice(&plaintext)
            .map_err(|_| "The decrypted collaboration operation is invalid.".to_string())?;
        Ok(DecryptedCollaborationOperation {
            session_id: operation.session_id,
            sequence: operation.sequence,
            operation_id: operation.operation_id,
            workflow_id: operation.workflow_id,
            actor_account_id: operation.actor_account_id,
            base_sequence: operation.base_sequence,
            client_sequence: operation.client_sequence,
            payload,
            created_at: operation.created_at,
            accepted_at: operation.accepted_at,
        })
    }

    pub fn encrypt_presence(
        &self,
        workflow_id: &str,
        session_id: &str,
        device_id: &str,
        value: &Value,
    ) -> Result<String, String> {
        validate_uuid(workflow_id, "Workflow")?;
        validate_uuid(session_id, "Collaboration session")?;
        validate_uuid(device_id, "Device")?;
        let plaintext = encode_value(value, MAX_PRESENCE_BYTES, "Collaboration presence")?;
        let key = self.load_key(session_id)?;
        let aad =
            format!("sndbox-collaboration-presence-v1:{workflow_id}:{session_id}:{device_id}");
        encrypt_blob(key.as_ref(), plaintext.as_slice(), aad.as_bytes())
    }

    pub fn decrypt_presence(
        &self,
        workflow_id: &str,
        session_id: &str,
        presence: EncryptedCollaborationPresence,
    ) -> Result<DecryptedCollaborationPresence, String> {
        validate_uuid(&presence.device_id, "Device")?;
        let key = self.load_key(session_id)?;
        let aad = format!(
            "sndbox-collaboration-presence-v1:{workflow_id}:{session_id}:{}",
            presence.device_id
        );
        let plaintext = decrypt_blob(key.as_ref(), &presence.encrypted_presence, aad.as_bytes())?;
        if plaintext.len() > MAX_PRESENCE_BYTES {
            return Err("The decrypted collaboration presence exceeds the 8 KB limit.".into());
        }
        let payload = serde_json::from_slice(&plaintext)
            .map_err(|_| "The decrypted collaboration presence is invalid.".to_string())?;
        Ok(DecryptedCollaborationPresence {
            account_id: presence.account_id,
            device_id: presence.device_id,
            display_name: presence.display_name,
            color: presence.color,
            payload,
            last_seen_at: presence.last_seen_at,
        })
    }

    pub fn forget_session(&self, session_id: &str) -> Result<(), String> {
        validate_uuid(session_id, "Collaboration session")?;
        self.vault.delete(&vault_id(session_id))
    }

    fn store_key(&self, session_id: &str, key: &[u8; 32]) -> Result<(), String> {
        self.vault.put(
            &vault_id(session_id),
            &serde_json::json!({"keyVersion":KEY_VERSION,"key":BASE64.encode(key)}),
        )
    }

    fn load_key(&self, session_id: &str) -> Result<Zeroizing<[u8; 32]>, String> {
        validate_uuid(session_id, "Collaboration session")?;
        let value = self.vault.get(&vault_id(session_id)).map_err(|_| {
            "The encryption key for this collaboration session is unavailable. Rejoin with its invite code."
                .to_string()
        })?;
        if value.get("keyVersion").and_then(Value::as_u64) != Some(KEY_VERSION as u64) {
            return Err("The collaboration encryption-key version is unsupported.".into());
        }
        let encoded = value
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| "The collaboration encryption key is corrupt.".to_string())?;
        decode_key(encoded).map(Zeroizing::new)
    }
}

fn validate_identifiers(
    workspace_id: &str,
    workflow_id: &str,
    session_id: &str,
) -> Result<(), String> {
    validate_uuid(workspace_id, "Workspace")?;
    validate_uuid(workflow_id, "Workflow")?;
    validate_uuid(session_id, "Collaboration session")
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} ID must be a UUID."))
}

fn vault_id(session_id: &str) -> String {
    format!("workflow-collaboration-{session_id}")
}

fn decode_key(encoded: &str) -> Result<[u8; 32], String> {
    let mut decoded = Zeroizing::new(
        BASE64
            .decode(encoded)
            .map_err(|_| "The collaboration encryption key is corrupt.".to_string())?,
    );
    let key = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "The collaboration encryption key has an invalid length.".to_string())?;
    decoded.zeroize();
    Ok(key)
}

fn encode_value(value: &Value, maximum: usize, label: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let encoded =
        serde_json::to_vec(value).map_err(|_| format!("{label} could not be encoded as JSON."))?;
    if encoded.len() > maximum {
        return Err(format!("{label} exceeds the {} KB limit.", maximum / 1024));
    }
    Ok(Zeroizing::new(encoded))
}

fn encrypt_blob(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "The collaboration encryption key has an invalid length.".to_string())?;
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
        .map_err(|_| "Collaboration encryption failed.".to_string())?;
    let mut blob = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(blob))
}

fn decrypt_blob(key: &[u8], encoded: &str, aad: &[u8]) -> Result<Vec<u8>, String> {
    let blob = BASE64
        .decode(encoded)
        .map_err(|_| "Encrypted collaboration data is not valid base64.".to_string())?;
    if blob.len() <= NONCE_BYTES {
        return Err("Encrypted collaboration data is truncated.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| "The collaboration encryption key has an invalid length.".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(&blob[..NONCE_BYTES]),
            Payload {
                msg: &blob[NONCE_BYTES..],
                aad,
            },
        )
        .map_err(|_| "Collaboration data failed authenticated decryption.".to_string())
}

fn payload_hash(encoded: &str) -> Result<String, String> {
    let blob = BASE64
        .decode(encoded)
        .map_err(|_| "Encrypted collaboration data is not valid base64.".to_string())?;
    Ok(format!("sha256:{}", hex(&Sha256::digest(blob))))
}

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryVault(Mutex<HashMap<String, Value>>);
    impl CredentialVault for MemoryVault {
        fn put(&self, id: &str, value: &Value) -> Result<(), String> {
            self.0.lock().insert(id.into(), value.clone());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Value, String> {
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

    fn identifiers() -> (String, String, String, String) {
        (
            Uuid::new_v4().to_string(),
            Uuid::new_v4().to_string(),
            Uuid::new_v4().to_string(),
            Uuid::new_v4().to_string(),
        )
    }

    #[test]
    fn invite_transfers_an_operation_key_without_server_plaintext() {
        let host = CollaborationCrypto::new(Arc::new(MemoryVault::default()));
        let guest = CollaborationCrypto::new(Arc::new(MemoryVault::default()));
        let (workspace, workflow, session, operation) = identifiers();
        let code = host.create_invite(&workspace, &workflow, &session).unwrap();
        assert!(code.starts_with(INVITE_PREFIX));
        assert!(!code.contains(&workspace));
        let invite = guest.inspect_invite(&code).unwrap();
        guest.accept_invite(&invite).unwrap();
        let payload = serde_json::json!({"changes":[{"kind":"node_move","nodeId":"a","position":{"x":4,"y":8}}]});
        let (encrypted_payload, payload_hash) = host
            .encrypt_operation(&workspace, &workflow, &session, &operation, &payload)
            .unwrap();
        assert!(!encrypted_payload.contains("node_move"));
        let decrypted = guest
            .decrypt_operation(
                &workspace,
                &workflow,
                &session,
                EncryptedCollaborationOperation {
                    session_id: session.clone(),
                    sequence: 1,
                    operation_id: operation,
                    workflow_id: workflow.clone(),
                    actor_account_id: Uuid::new_v4().to_string(),
                    base_sequence: 0,
                    client_sequence: 1,
                    encrypted_payload,
                    payload_hash,
                    created_at: Utc::now(),
                    accepted_at: Utc::now(),
                },
            )
            .unwrap();
        assert_eq!(decrypted.payload, payload);
    }

    #[test]
    fn rejects_invite_ciphertext_and_context_tampering() {
        let crypto = CollaborationCrypto::new(Arc::new(MemoryVault::default()));
        let (workspace, workflow, session, operation) = identifiers();
        let code = crypto
            .create_invite(&workspace, &workflow, &session)
            .unwrap();
        assert!(crypto.inspect_invite(&(code + "x")).is_err());
        let payload = serde_json::json!({"selectedNodeIds":[]});
        let encrypted = crypto
            .encrypt_presence(&workflow, &session, &operation, &payload)
            .unwrap();
        let presence = EncryptedCollaborationPresence {
            account_id: Uuid::new_v4().to_string(),
            device_id: operation,
            display_name: "Guest".into(),
            color: "#5b8def".into(),
            encrypted_presence: encrypted,
            last_seen_at: Utc::now(),
        };
        assert!(crypto
            .decrypt_presence(&Uuid::new_v4().to_string(), &session, presence)
            .is_err());
    }
}
