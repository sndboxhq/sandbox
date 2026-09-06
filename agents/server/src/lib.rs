pub mod client;
pub mod config;
pub mod identity;
pub mod pairing;
pub mod runner;
pub mod agent_host;
#[path = "../../../src-tauri/src/credential_vault.rs"]
pub mod credential_vault;
#[path = "../../../src-tauri/src/plugin_manager.rs"]
pub mod plugin_manager;
#[path = "../../../src-tauri/src/provider_adapter.rs"]
pub mod provider_adapter;

pub const RUNNER_PROTOCOL_VERSION: u16 = 2;
pub const ENGINE_VERSION: &str = "0.7.9-beta.1";
pub const PLUGIN_RUNTIME_VERSION: &str = "0.7.9-beta.1";
