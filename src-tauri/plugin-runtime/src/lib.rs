mod broker;
mod error;
mod manifest;
mod package;
mod runtime;
mod schema;

pub use broker::{
    CapabilityBroker, CredentialOperationBroker, ExecutionContext, HostRequest, HostResponse,
    HttpRequest, HttpResponse, InMemoryPluginStorage, NetworkTransport, PluginStorage,
    ReqwestTransport, StorageScope,
};
pub use error::PluginError;
pub use manifest::{
    canonical_manifest, permission_diff, permission_summary, Capability, ConnectionRequirement,
    CredentialDefinition, Entrypoint, ExternalEffect, FileInputDefinition, HttpMethod, Manifest,
    ManifestValidation, MigrationDefinition, NetworkDomain, NodeDefinition, NodeKind,
    NodePlacement, NodePort, Pricing, Signature, StorageRequirements,
};
pub use package::{package_digest, PackageTrustStore, RevocationList, VerifiedPackage};
pub use runtime::{PluginRuntime, RuntimeLimits, SandboxDiagnostic};
pub use schema::validate_schema_instance;

pub const HOST_VERSION: &str = "0.7.10-beta.2";
pub const MANIFEST_VERSION: u32 = 2;
