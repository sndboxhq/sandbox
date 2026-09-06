use sandbox_server_runner::{
    config::{CertificateConfig, ConfigError, RunnerConfig, UpdateMode},
    identity::StoredIdentity,
    runner::CommandVerifier,
    ENGINE_VERSION,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    thread,
    time::Duration,
};

#[cfg(target_os = "windows")]
pub const OS_LABEL: &str = "Windows";
#[cfg(target_os = "windows")]
pub const DOCS_URL: &str = "https://docs.sndbox.app/windows";
#[cfg(target_os = "windows")]
pub const DEFAULT_CONFIG: &str = r"C:\ProgramData\sndbox-runner\config.toml";
#[cfg(target_os = "windows")]
pub const DEFAULT_DATA_DIR: &str = r"C:\ProgramData\sndbox-runner";
#[cfg(target_os = "windows")]
pub const DEFAULT_PLUGIN_CACHE: &str = r"C:\ProgramData\sndbox-runner\plugins";
#[cfg(target_os = "windows")]
pub const DEFAULT_WORK_DIR: &str = r"C:\Users\Public\sndbox\automation";
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub const SERVICE_UNIT: &str = "sandbox-runner";
#[cfg(target_os = "windows")]
pub const PLATFORM_TAG: &str = "windows";

#[cfg(not(target_os = "windows"))]
pub const OS_LABEL: &str = "Linux";
#[cfg(not(target_os = "windows"))]
pub const DOCS_URL: &str = "https://docs.sndbox.app/linux";
#[cfg(not(target_os = "windows"))]
pub const DEFAULT_CONFIG: &str = "/etc/sandbox-runner/config.toml";
#[cfg(not(target_os = "windows"))]
pub const DEFAULT_DATA_DIR: &str = "/var/lib/sandbox-runner";
#[cfg(not(target_os = "windows"))]
pub const DEFAULT_PLUGIN_CACHE: &str = "/var/lib/sandbox-runner/plugins";
#[cfg(not(target_os = "windows"))]
pub const DEFAULT_WORK_DIR: &str = "/srv/automation";
#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub const SERVICE_UNIT: &str = "sandbox-runner.service";
#[cfg(not(target_os = "windows"))]
pub const PLATFORM_TAG: &str = "linux";

/// Compile-time error-code constant with the platform-specific prefix
/// (`SBX-LNX-` on Linux/other, `SBX-WIN-` on Windows).
#[macro_export]
macro_rules! sbx_code {
    ($n:literal) => {{
        #[cfg(target_os = "windows")]
        {
            concat!("SBX-WIN-", $n)
        }
        #[cfg(not(target_os = "windows"))]
        {
            concat!("SBX-LNX-", $n)
        }
    }};
}

#[derive(Debug)]
pub struct CliError {
    pub code: &'static str,
    pub message: String,
    pub help: Option<String>,
    pub exit_code: i32,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>, exit_code: i32) -> Self {
        Self {
            code,
            message: message.into(),
            help: None,
            exit_code,
        }
    }

    pub fn help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(sbx_code!("1004"), message, 2)
            .help(format!("Run `sandbox-runner --help` or visit {DOCS_URL}."))
    }

    pub fn config(path: &Path, error: ConfigError) -> Self {
        match error {
            ConfigError::Io(source) if source.kind() == io::ErrorKind::NotFound => Self::new(
                sbx_code!("1001"),
                format!("Configuration was not found at {}.", path.display()),
                2,
            )
            .help(setup_help()),
            ConfigError::Io(source) if source.kind() == io::ErrorKind::PermissionDenied => Self::new(
                sbx_code!("1002"),
                format!("Configuration at {} is not readable by this user.", path.display()),
                2,
            )
            .help(readable_help()),
            other => Self::new(
                sbx_code!("1003"),
                format!("Configuration at {} is invalid: {other}", path.display()),
                2,
            )
            .help("Run `sandbox-runner doctor` for checks and field-level guidance."),
        }
    }

    pub fn filesystem(action: &str, error: impl std::fmt::Display) -> Self {
        Self::new(sbx_code!("3001"), format!("{action}: {error}"), 3)
            .help("Check the path, ownership, free space, and service-account permissions.")
    }

    pub fn pairing(message: impl Into<String>) -> Self {
        Self::new(sbx_code!("2001"), message, 4)
            .help("Create a fresh token in Account → Operations, then retry as the service account.")
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(sbx_code!("2002"), message, 5).help(
            "Check DNS, HTTPS, proxy and certificate settings, then run `sandbox-runner doctor`.",
        )
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self::new(sbx_code!("9001"), message, 10).help(format!(
            "Run `sandbox-runner doctor`; if it persists, see {DOCS_URL}#error-codes."
        ))
    }
}

fn setup_help() -> String {
    #[cfg(target_os = "windows")]
    {
        "Run `sandbox-runner setup` from an elevated PowerShell.".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Run `sudo sandbox-runner setup` to create and validate it.".into()
    }
}

fn readable_help() -> String {
    #[cfg(target_os = "windows")]
    {
        "Run the command as an Administrator or as the sandbox-runner service account. Confirm the file's ACL grants read to Administrators and the service account.".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Run the command as the sandbox-runner service account, or repair the file owner and group.".into()
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "error[{}]: {}", self.code, self.message)?;
        if let Some(help) = &self.help {
            write!(formatter, "\nhelp: {help}")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: &'static str,
    pub state: CheckState,
    pub detail: String,
    pub code: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSummary {
    pub version: &'static str,
    pub operating_system: &'static str,
    pub architecture: &'static str,
    pub config_path: String,
    pub configured: bool,
    pub config_detail: String,
    pub runner_name: Option<String>,
    pub environment: Option<String>,
    pub paired: bool,
    pub runner_id: Option<String>,
    pub service: String,
}

pub fn load_config(path: &Path) -> Result<RunnerConfig, CliError> {
    RunnerConfig::load(path).map_err(|error| CliError::config(path, error))
}

pub fn runner_summary(path: &Path) -> RunnerSummary {
    let mut summary = RunnerSummary {
        version: ENGINE_VERSION,
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        config_path: path.display().to_string(),
        configured: false,
        config_detail: "not found".into(),
        runner_name: None,
        environment: None,
        paired: false,
        runner_id: None,
        service: service_state(),
    };

    match RunnerConfig::load(path) {
        Ok(config) => {
            summary.configured = true;
            summary.config_detail = "valid".into();
            summary.runner_name = Some(config.runner_name.clone());
            summary.environment = Some(config.environment.clone());
            let identity_path = config.data_directory.join("identity.json");
            match StoredIdentity::load(&identity_path) {
                Ok(identity) => {
                    summary.paired = true;
                    summary.runner_id = Some(identity.runner_id);
                }
                Err(_) if identity_path.exists() => {
                    summary.config_detail = "valid; identity is unreadable".into()
                }
                Err(_) => {}
            }
        }
        Err(ConfigError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => summary.config_detail = error.to_string(),
    }
    summary
}

pub fn doctor(path: &Path) -> Vec<Check> {
    let mut checks = Vec::new();
    let supported = supported_platform();
    checks.push(Check {
        name: "platform",
        state: if supported {
            CheckState::Pass
        } else {
            CheckState::Fail
        },
        detail: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
        code: (!supported).then_some(sbx_code!("1101")),
    });

    let config = match RunnerConfig::load(path) {
        Ok(config) => {
            checks.push(Check {
                name: "configuration",
                state: CheckState::Pass,
                detail: path.display().to_string(),
                code: None,
            });
            Some(config)
        }
        Err(error) => {
            let mapped = CliError::config(path, error);
            checks.push(Check {
                name: "configuration",
                state: CheckState::Fail,
                detail: mapped.message,
                code: Some(mapped.code),
            });
            None
        }
    };

    if let Some(config) = config {
        match CommandVerifier::from_config(&config) {
            Ok(_) => checks.push(Check {
                name: "signing keys",
                state: CheckState::Pass,
                detail: format!("{} trusted key(s)", config.command_signing_keys.len()),
                code: None,
            }),
            Err(error) => checks.push(Check {
                name: "signing keys",
                state: CheckState::Fail,
                detail: error,
                code: Some(sbx_code!("1102")),
            }),
        }

        let identity_path = config.data_directory.join("identity.json");
        match StoredIdentity::load(&identity_path) {
            Ok(identity) => checks.push(Check {
                name: "pairing",
                state: CheckState::Pass,
                detail: format!("runner {}", short_id(&identity.runner_id)),
                code: None,
            }),
            Err(error) if identity_path.exists() => checks.push(Check {
                name: "pairing",
                state: CheckState::Fail,
                detail: format!("identity is invalid: {error}"),
                code: Some(sbx_code!("1006")),
            }),
            Err(_) => checks.push(Check {
                name: "pairing",
                state: CheckState::Warn,
                detail: "not paired yet".into(),
                code: Some(sbx_code!("1005")),
            }),
        }

        checks.push(path_check("data directory", &config.data_directory, true));
        checks.push(path_check("plugin cache", &config.plugin_cache, true));
        for directory in &config.allowed_working_directories {
            checks.push(path_check("working directory", directory, false));
        }
    }

    let service = service_state();
    #[cfg(target_os = "windows")]
    let service_check_name = "windows service";
    #[cfg(not(target_os = "windows"))]
    let service_check_name = "systemd service";
    checks.push(Check {
        name: service_check_name,
        state: match service.as_str() {
            "active" | "running" => CheckState::Pass,
            _ => CheckState::Warn,
        },
        detail: service,
        code: None,
    });
    checks
}

fn supported_platform() -> bool {
    let arch_ok = matches!(std::env::consts::ARCH, "x86_64" | "aarch64");
    let os_ok = cfg!(target_os = "linux") || cfg!(target_os = "windows");
    arch_ok && os_ok
}

fn path_check(name: &'static str, path: &Path, needs_write: bool) -> Check {
    if !path.exists() {
        return Check {
            name,
            state: CheckState::Fail,
            detail: format!("{} does not exist", path.display()),
            code: Some(sbx_code!("3002")),
        };
    }
    if !path.is_dir() {
        return Check {
            name,
            state: CheckState::Fail,
            detail: format!("{} is not a directory", path.display()),
            code: Some(sbx_code!("3003")),
        };
    }
    if needs_write {
        let metadata = fs::metadata(path);
        if metadata
            .as_ref()
            .is_ok_and(|item| item.permissions().readonly())
        {
            return Check {
                name,
                state: CheckState::Fail,
                detail: format!("{} is read-only", path.display()),
                code: Some(sbx_code!("3004")),
            };
        }
    }
    Check {
        name,
        state: CheckState::Pass,
        detail: path.display().to_string(),
        code: None,
    }
}

pub fn print_doctor(checks: &[Check], json: bool) -> Result<(), CliError> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(checks)
                .map_err(|error| CliError::runtime(error.to_string()))?
        );
        return Ok(());
    }
    println!("sndbox {OS_LABEL} doctor\n");
    for check in checks {
        let (symbol, label) = match check.state {
            CheckState::Pass => ("✓", "pass"),
            CheckState::Warn => ("!", "warn"),
            CheckState::Fail => ("✗", "fail"),
        };
        let code = check
            .code
            .map(|value| format!(" [{value}]"))
            .unwrap_or_default();
        println!(
            " {symbol} {:<18} {:<4}  {}{code}",
            check.name, label, check.detail
        );
    }
    println!("\nDocs: {DOCS_URL}");
    Ok(())
}

pub fn print_status(path: &Path, json: bool) -> Result<(), CliError> {
    let status = runner_summary(path);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&status)
                .map_err(|error| CliError::runtime(error.to_string()))?
        );
        return Ok(());
    }
    println!("sndbox {OS_LABEL} {}\n", status.version);
    println!(
        "  Runner       {}",
        status.runner_name.as_deref().unwrap_or("not configured")
    );
    println!(
        "  Environment  {}",
        status.environment.as_deref().unwrap_or("—")
    );
    println!(
        "  Config       {} ({})",
        status.config_path, status.config_detail
    );
    println!(
        "  Pairing      {}",
        if status.paired {
            "paired"
        } else {
            "not paired"
        }
    );
    if let Some(id) = status.runner_id {
        println!("  Runner ID    {id}");
    }
    println!("  Service      {}", status.service);
    Ok(())
}

pub fn interactive_setup(path: &Path, force: bool) -> Result<(), CliError> {
    require_terminal("setup")?;
    #[cfg(unix)]
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(CliError::new(
            sbx_code!("3001"),
            format!(
                "Refusing to replace symbolic-link configuration path {}.",
                path.display()
            ),
            3,
        )
        .help("Use the canonical regular-file path and run setup again."));
    }
    let packaged_template = is_packaged_template(path);
    if path.exists() && !force && !packaged_template {
        return Err(CliError::new(
            sbx_code!("1007"),
            format!("{} already exists; setup did not change it.", path.display()),
            2,
        )
        .help("Run `sandbox-runner validate`, or rerun setup with `--force` to create a timestamp-free `.bak` copy first."));
    }

    let default_data_dir = PathBuf::from(DEFAULT_DATA_DIR);
    let identity = RunnerConfig::load(path)
        .map(|existing| existing.data_directory.join("identity.json"))
        .unwrap_or_else(|_| default_data_dir.join("identity.json"));
    if identity.exists() {
        return Err(CliError::new(
            sbx_code!("1008"),
            "A paired runner cannot be reconfigured by setup.",
            3,
        )
        .help("Revoke the runner in Account → Operations and remove its identity before changing its trust boundary."));
    }

    println!("sndbox {OS_LABEL} setup\n");
    println!(
        "This creates one validated runner config. Press Enter to accept a value in [brackets].\n"
    );

    let control_plane_url = prompt("Control plane URL", Some("https://api.sndbox.app"))?;
    let runner_name = prompt("Runner name", Some(hostname_default().as_str()))?;
    let workspace_id = prompt(
        "Workspace ID",
        env::var("SANDBOX_WORKSPACE_ID").ok().as_deref(),
    )?;
    let environment_id = prompt(
        "Environment ID",
        env::var("SANDBOX_ENVIRONMENT_ID").ok().as_deref(),
    )?;
    let environment = prompt_choice(
        "Environment",
        &["development", "staging", "production"],
        "production",
    )?;
    let concurrency = prompt("Concurrent jobs", Some("2"))?
        .parse::<u16>()
        .map_err(|_| {
            CliError::invalid_input("Concurrent jobs must be a number between 1 and 128.")
        })?;
    let working_directory = prompt("Allowed workflow directory", Some(DEFAULT_WORK_DIR))?;
    let key_id = prompt(
        "Command-signing key ID",
        env::var("SANDBOX_COMMAND_SIGNING_KEY_ID").ok().as_deref(),
    )?;
    let public_key = prompt(
        "Command-signing public key",
        env::var("SANDBOX_COMMAND_SIGNING_PUBLIC_KEY")
            .ok()
            .as_deref(),
    )?;

    let mut keys = BTreeMap::new();
    keys.insert(key_id, public_key);
    let config = RunnerConfig {
        config_version: 1,
        control_plane_url,
        runner_name,
        workspace_id,
        environment_id,
        environment,
        tags: vec![PLATFORM_TAG.into(), "always-on".into()],
        concurrency,
        data_directory: default_data_dir.clone(),
        plugin_cache: PathBuf::from(DEFAULT_PLUGIN_CACHE),
        allowed_working_directories: vec![PathBuf::from(working_directory)],
        approved_network_targets: vec![],
        log_level: "info".into(),
        update_channel: "preview".into(),
        update_mode: UpdateMode::NotifyOnly,
        pinned_version_range: None,
        maintenance_window: None,
        proxy: None,
        certificate: CertificateConfig {
            ca_file: None,
            client_certificate_file: None,
            client_key_file: None,
        },
        drain_timeout_seconds: 60,
        enable_managed_chromium: false,
        allow_simple_commands: false,
        command_signing_keys: keys,
    };
    config
        .validate()
        .map_err(|error| CliError::config(path, error))?;
    CommandVerifier::from_config(&config).map_err(|error| {
        CliError::new(
            sbx_code!("1102"),
            format!("Command-signing key is invalid: {error}"),
            2,
        )
        .help(
            "Copy the complete Ed25519 public key and key ID supplied by the sndbox control plane.",
        )
    })?;

    let rendered =
        toml::to_string_pretty(&config).map_err(|error| CliError::runtime(error.to_string()))?;
    write_config(path, rendered.as_bytes(), force || packaged_template)?;
    println!(
        "\n✓ Configuration written and validated: {}",
        path.display()
    );
    println!("\nNext:");
    for step in home_next_steps() {
        println!("  {step}");
    }
    println!("\nDocs: {DOCS_URL}");
    Ok(())
}

fn is_packaged_template(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|contents| {
        contents.contains("workspace_id = \"replace-with-workspace-id\"")
            && contents.contains("environment_id = \"replace-with-environment-id\"")
            && contents.contains("control_plane_url = \"https://control.example.com\"")
    })
}

fn write_config(path: &Path, data: &[u8], force: bool) -> Result<(), CliError> {
    let parent = path
        .parent()
        .ok_or_else(|| CliError::invalid_input("Configuration path has no parent directory."))?;
    fs::create_dir_all(parent).map_err(|error| {
        CliError::filesystem("Could not create the configuration directory", error)
    })?;
    if force && path.exists() {
        let backup = next_backup_path(path);
        fs::copy(path, &backup).map_err(|error| {
            CliError::filesystem("Could not back up the existing configuration", error)
        })?;
        println!("Backup: {}", backup.display());
    }
    let temporary = parent.join(format!(".config.{}.tmp", std::process::id()));
    // `setup` normally runs with sudo, but the installed service reads this
    // file as sandbox-runner. Preserve ownership of the replaced configuration
    // so an atomic rewrite never changes root:sandbox-runner 0640 into root:root.
    #[cfg(unix)]
    let existing_ownership = fs::metadata(path).ok().map(|metadata| {
        use std::os::unix::fs::MetadataExt;
        (metadata.uid(), metadata.gid())
    });
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o640);
    }
    let mut file = options.open(&temporary).map_err(|error| {
        CliError::filesystem("Could not create a temporary configuration", error)
    })?;
    if let Err(error) = file.write_all(data).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(CliError::filesystem(
            "Could not write the configuration",
            error,
        ));
    }
    drop(file);
    #[cfg(unix)]
    if let Some((uid, gid)) = existing_ownership {
        preserve_owner(&temporary, uid, gid)?;
    }
    #[cfg(unix)]
    fs::rename(&temporary, path).map_err(|error| {
        CliError::filesystem("Could not atomically install the configuration", error)
    })?;
    #[cfg(not(unix))]
    {
        if path.exists() {
            fs::remove_file(path).map_err(|error| {
                CliError::filesystem("Could not replace the existing configuration", error)
            })?;
        }
        fs::rename(&temporary, path)
            .map_err(|error| CliError::filesystem("Could not install the configuration", error))?;
    }
    Ok(())
}

#[cfg(unix)]
fn preserve_owner(path: &Path, uid: u32, gid: u32) -> Result<(), CliError> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        CliError::invalid_input("Configuration path contains an unsupported NUL byte.")
    })?;
    // SAFETY: the pathname is NUL-terminated; uid/gid are copied from the file
    // being replaced; and only the new temporary file is changed before rename.
    if unsafe { libc::chown(path.as_ptr(), uid, gid) } != 0 {
        return Err(CliError::filesystem(
            "Could not preserve configuration ownership",
            io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn next_backup_path(path: &Path) -> PathBuf {
    let first = path.with_extension("toml.bak");
    if !first.exists() {
        return first;
    }
    for index in 1..=999 {
        let candidate = path.with_extension(format!("toml.bak.{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.with_extension(format!("toml.bak.{}", std::process::id()))
}

pub async fn home(path: &Path) -> Result<(), CliError> {
    require_terminal("interactive home")?;
    enable_virtual_terminal();
    let color = colors_enabled();
    let pal = palette(color);
    let _alt = AltScreen::enter();

    let mut first_render = true;
    loop {
        let summary = runner_summary(path);
        if first_render {
            animate_home(&summary, color);
            first_render = false;
        } else {
            print!("\x1b[H\x1b[2J");
            print_home(&summary, &pal, 0);
        }

        // Prompt line is positioned two rows below the box + status hints
        // (~18 rows in) via the trailing \n\n in print_home and this show-cursor.
        print!(
            "{brand}{bold}▸{r} ",
            brand = pal.brand_bright,
            bold = pal.bold,
            r = pal.reset,
        );
        print!("\x1b[?25h");
        io::stdout()
            .flush()
            .map_err(|error| CliError::runtime(error.to_string()))?;
        let mut input = String::new();
        let read = io::stdin()
            .read_line(&mut input)
            .map_err(|error| CliError::runtime(error.to_string()))?;
        print!("\x1b[?25l");
        io::stdout()
            .flush()
            .map_err(|error| CliError::runtime(error.to_string()))?;
        if read == 0 {
            return Ok(());
        }

        let command = input.trim().trim_start_matches('/').to_owned();
        match command.as_str() {
            "" => continue,
            "quit" | "exit" | "q" => return Ok(()),
            _ => {
                // Clear the alt-screen canvas, run the command inline, then
                // wait for Enter before redrawing the home.
                print!("\x1b[H\x1b[2J\x1b[?25h");
                io::stdout()
                    .flush()
                    .map_err(|error| CliError::runtime(error.to_string()))?;
                match command.as_str() {
                    "help" | "?" => print_home_help(),
                    "status" => print_status(path, false)?,
                    "doctor" => print_doctor(&doctor(path), false)?,
                    "setup" => interactive_setup(path, false)?,
                    "pair" => println!("{}", pair_hint()),
                    "start" => println!("{}", start_hint()),
                    "logs" => println!("{}", logs_hint()),
                    other => {
                        println!("Unknown command `{other}`. Type /help for shortcuts.");
                    }
                }
                println!(
                    "\n{d}Press Enter to return home.{r}",
                    d = pal.dim,
                    r = pal.reset
                );
                io::stdout()
                    .flush()
                    .map_err(|error| CliError::runtime(error.to_string()))?;
                let mut pause = String::new();
                io::stdin()
                    .read_line(&mut pause)
                    .map_err(|error| CliError::runtime(error.to_string()))?;
                print!("\x1b[?25l");
            }
        }
    }
}

fn animate_home(summary: &RunnerSummary, color: bool) {
    let reduced_motion = env::var("SANDBOX_REDUCE_MOTION").is_ok_and(|value| value != "0")
        || env::var("TERM").is_ok_and(|value| value == "dumb");
    let pal = palette(color);
    if !reduced_motion {
        for frame in [0, 1, 2, 1] {
            print_home(summary, &pal, frame);
            thread::sleep(Duration::from_millis(85));
        }
    }
    print_home(summary, &pal, 0);
}

/// 256-colour palette used across the home. Every field is a raw ANSI SGR
/// sequence, or the empty string when colour is disabled so the same rendering
/// code works on dumb terminals.
struct Palette {
    reset: &'static str,
    dim: &'static str,
    bold: &'static str,
    border: &'static str,
    brand: &'static str,
    brand_bright: &'static str,
    brand_muted: &'static str,
    brand_shadow: &'static str,
    accent: &'static str,
    ready: &'static str,
    pending: &'static str,
    label: &'static str,
    value: &'static str,
    ghost: &'static str,
}

const NO_COLOR: Palette = Palette {
    reset: "",
    dim: "",
    bold: "",
    border: "",
    brand: "",
    brand_bright: "",
    brand_muted: "",
    brand_shadow: "",
    accent: "",
    ready: "",
    pending: "",
    label: "",
    value: "",
    ghost: "",
};

fn palette(enabled: bool) -> Palette {
    if !enabled {
        return NO_COLOR;
    }
    Palette {
        reset: "\x1b[0m",
        dim: "\x1b[2m",
        bold: "\x1b[1m",
        border: "\x1b[38;5;95m",
        brand: "\x1b[38;5;208m",
        brand_bright: "\x1b[38;5;214m",
        brand_muted: "\x1b[38;5;173m",
        brand_shadow: "\x1b[38;5;130m",
        accent: "\x1b[38;5;80m",
        ready: "\x1b[38;5;82m",
        pending: "\x1b[38;5;222m",
        label: "\x1b[38;5;245m",
        value: "\x1b[38;5;253m",
        ghost: "\x1b[38;5;240m",
    }
}

fn print_home(summary: &RunnerSummary, pal: &Palette, crab_frame: usize) {
    let user = env::var("SUDO_USER")
        .or_else(|_| env::var("USER"))
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "there".into());
    let runner_configured = summary.runner_name.is_some();
    let runner = summary.runner_name.as_deref().unwrap_or("not configured");
    let environment = summary.environment.as_deref().unwrap_or("—");
    let service_running = matches!(summary.service.as_str(), "active" | "running");
    let ready = summary.configured && summary.paired && service_running;
    let states = step_states(summary);

    print!("\x1b[2J\x1b[H");
    println!("{}", header_line(summary.version, pal));
    println!("{}", body_row("", "", pal));
    println!(
        "{}",
        body_row(
            &welcome_cell(&user, pal),
            &format!(
                "{d}{}Getting started{r}",
                pal.label,
                d = pal.dim,
                r = pal.reset
            ),
            pal,
        )
    );

    let crab = hermit_crab(crab_frame);
    let crab_colors = crab_row_styles(pal);
    let right_lines = [
        step_row(0, states[0], "/setup", "guided configuration", pal),
        step_row(1, states[1], "/pair", "connect this machine", pal),
        step_row(2, states[2], "/start", "run in the background", pal),
        String::new(),
        format!(
            "{d}/doctor  /status  /logs  /help{r}",
            d = pal.ghost,
            r = pal.reset
        ),
        String::new(),
    ];
    for (index, (line, right)) in crab.iter().zip(right_lines.iter()).enumerate() {
        println!(
            "{}",
            body_row(
                &format!(
                    "{color}{line}{reset}",
                    color = crab_colors[index],
                    reset = pal.reset
                ),
                right,
                pal,
            )
        );
    }

    println!("{}", divider_line(pal));

    let runner_value = value_cell(runner, runner_configured, pal);
    let environment_value = value_cell(environment, summary.environment.is_some(), pal);
    let pairing_value = value_cell(
        if summary.paired { "paired" } else { "not paired" },
        summary.paired,
        pal,
    );
    let service_value = value_cell(&summary.service, service_running, pal);
    println!(
        "{}",
        body_row(
            &info_cell("Runner", &runner_value, 12, pal),
            &info_cell("Environment", &environment_value, 14, pal),
            pal,
        )
    );
    println!(
        "{}",
        body_row(
            &info_cell("Pairing", &pairing_value, 12, pal),
            &info_cell("Service", &service_value, 14, pal),
            pal,
        )
    );
    println!("{}", footer_line(pal));

    let (mark, tone, text) = if ready {
        ("●", pal.ready, "ready")
    } else {
        ("○", pal.pending, "setup needed")
    };
    println!(
        "\n  {tone}{mark} {b}{text}{r}   {ghost}⚙  {}{r}",
        summary.config_path,
        b = pal.bold,
        r = pal.reset,
        ghost = pal.ghost,
    );
    println!(
        "  {d}Type a shortcut below.  /quit exits; the runner service keeps running.{r}",
        d = pal.dim,
        r = pal.reset,
    );
}

// ── Header, divider, footer ────────────────────────────────────────────────

fn header_line(version: &'static str, pal: &Palette) -> String {
    let brand = format!(
        "{b}sndbox{r}{brand} {os}{r} {dim}· v{ver}{r}",
        b = pal.bold,
        r = pal.reset,
        brand = pal.brand_bright,
        dim = pal.dim,
        os = OS_LABEL,
        ver = version,
    );
    let brand_width = visible_width(&brand);
    let fill = "─".repeat(76usize.saturating_sub(brand_width + 2));
    format!(
        "{b}╭─ {r}{brand} {b}{fill}╮{r}",
        b = pal.border,
        r = pal.reset,
        brand = brand,
        fill = fill
    )
}

fn divider_line(pal: &Palette) -> String {
    format!(
        "{b}├{fill}┤{r}",
        b = pal.border,
        r = pal.reset,
        fill = "─".repeat(78)
    )
}

fn footer_line(pal: &Palette) -> String {
    format!(
        "{b}╰{fill}╯{r}",
        b = pal.border,
        r = pal.reset,
        fill = "─".repeat(78)
    )
}

fn body_row(left: &str, right: &str, pal: &Palette) -> String {
    format!(
        "{b}│{r} {} {} {b}│{r}",
        pad_visible(left, 37),
        pad_visible(right, 38),
        b = pal.border,
        r = pal.reset,
    )
}

// ── Cells ──────────────────────────────────────────────────────────────────

fn welcome_cell(user: &str, pal: &Palette) -> String {
    let name = truncate(user, 20);
    format!(
        "{d}Welcome back,{r} {a}{name}{r}",
        d = pal.dim,
        r = pal.reset,
        a = pal.accent,
    )
}

fn value_cell(value: &str, ok: bool, pal: &Palette) -> String {
    let colour = if ok { pal.value } else { pal.brand_muted };
    format!("{colour}{value}{r}", r = pal.reset)
}

fn info_cell(label: &str, value: &str, label_col: usize, pal: &Palette) -> String {
    let label_padded = format!("{:<width$}", label, width = label_col);
    format!(
        "{lc}{label}{r}{value}",
        lc = pal.label,
        r = pal.reset,
        label = label_padded,
        value = value
    )
}

// ── Steps ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StepState {
    Done,
    Next,
    Pending,
}

fn step_states(summary: &RunnerSummary) -> [StepState; 3] {
    let running = matches!(summary.service.as_str(), "active" | "running");
    let mut states = [
        if summary.configured {
            StepState::Done
        } else {
            StepState::Pending
        },
        if summary.paired {
            StepState::Done
        } else {
            StepState::Pending
        },
        if running {
            StepState::Done
        } else {
            StepState::Pending
        },
    ];
    for state in states.iter_mut() {
        if *state == StepState::Pending {
            *state = StepState::Next;
            break;
        }
    }
    states
}

fn step_row(index: usize, state: StepState, command: &str, blurb: &str, pal: &Palette) -> String {
    let number = index + 1;
    let (marker, number_text, command_colour, blurb_colour) = match state {
        StepState::Done => (
            format!("{c}  {r}", c = pal.ready, r = pal.reset),
            format!("{c}✓{r}", c = pal.ready, r = pal.reset),
            pal.dim,
            pal.dim,
        ),
        StepState::Next => (
            format!("{c}{b}▸ {r}", c = pal.brand_bright, b = pal.bold, r = pal.reset),
            format!(
                "{c}{b}{n}{r}",
                c = pal.brand_bright,
                b = pal.bold,
                n = number,
                r = pal.reset
            ),
            pal.value,
            pal.label,
        ),
        StepState::Pending => (
            format!("{d}  {r}", d = pal.ghost, r = pal.reset),
            format!("{d}{n}{r}", d = pal.ghost, n = number, r = pal.reset),
            pal.ghost,
            pal.ghost,
        ),
    };
    let padded_command = format!("{:<width$}", command, width = 7);
    format!(
        "{marker}{number_text}  {cc}{cmd}{r}  {bc}{blurb}{r}",
        cc = command_colour,
        bc = blurb_colour,
        r = pal.reset,
        cmd = padded_command,
        blurb = blurb,
    )
}

// ── Crab ───────────────────────────────────────────────────────────────────

fn crab_row_styles(pal: &Palette) -> [&'static str; 6] {
    [
        pal.brand_muted,
        pal.brand,
        pal.brand_bright,
        pal.brand_bright,
        pal.brand,
        pal.brand_shadow,
    ]
}

fn hermit_crab(frame: usize) -> [&'static str; 6] {
    // Left column (37 wide) is coloured per-row by crab_row_styles(). The
    // right-hand crab (eyes/mouth/legs) reads with those colours because
    // per-character colouring here would break visible-width padding. Kept
    // ≤35 chars per row so body_row can safely pad to the 37-col left cell.
    match frame % 3 {
        1 => [
            "         ______",
            "      .-'  ●   `-.        _/  _",
            "    .'  ░░░░░░░░  '.  __(◕)_(◕)__",
            "   /  ░░░░░░░░░░░░  \\_/    ‿    \\_",
            "   \\  ░░░░░░░░░░░░  /\\__\\_____/__/",
            "    '.____________.'     /_/ \\_\\",
        ],
        2 => [
            "          ______",
            "       .-'   ●  `-.       _  \\_",
            "     .'  ░░░░░░░░  '.  __(◕)_(◕)__",
            "    /  ░░░░░░░░░░░░  \\/    ‿    \\_",
            "    \\  ░░░░░░░░░░░░  /\\__\\_____/__/",
            "     '.____________.'    /_/ \\_\\",
        ],
        _ => [
            "         ______",
            "      .-'   ●  `-.        _   _",
            "    .'  ░░░░░░░░  '.  __(◕)_(◕)__",
            "   /  ░░░░░░░░░░░░  \\_/    ‿    \\_",
            "   \\  ░░░░░░░░░░░░  /\\__\\_____/__/",
            "    '.____________.'     /_/ \\_\\",
        ],
    }
}

fn print_home_help() {
    println!("Commands\n  /setup   Create a validated configuration\n  /doctor  Check platform, config, pairing, paths and service\n  /status  Show runner state\n  /pair    Show the safe pairing command\n  /start   Show the service start command\n  /logs    Show the service log command\n  /quit    Exit this terminal home\n\nAll non-interactive commands: sandbox-runner --help");
}

// ── Visible-width helpers (ANSI-escape aware) ──────────────────────────────

fn visible_width(s: &str) -> usize {
    let mut count = 0usize;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            count += 1;
        }
    }
    count
}

fn pad_visible(s: &str, width: usize) -> String {
    let vw = visible_width(s);
    if vw >= width {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + (width - vw));
    out.push_str(s);
    for _ in 0..(width - vw) {
        out.push(' ');
    }
    out
}

// Retained for the existing width test; the live home uses `body_row`.
#[cfg(test)]
fn card_row(left: &str, right: &str) -> String {
    format!("│ {:<37} {:<38} │", truncate(left, 37), truncate(right, 38))
}

fn home_next_steps() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        vec![
            "1. Pair:  sandbox-runner pair  (from an elevated PowerShell)".into(),
            "2. Start: sc.exe start sandbox-runner".into(),
            "3. Check: sandbox-runner status".into(),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![
            "1. Pair:  sudo -u sandbox-runner /usr/local/bin/sandbox-runner pair".into(),
            "2. Start: sudo systemctl enable --now sandbox-runner".into(),
            "3. Check: sandbox-runner status".into(),
        ]
    }
}

fn pair_hint() -> String {
    #[cfg(target_os = "windows")]
    {
        "From an elevated PowerShell:\n  sandbox-runner pair".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Run as the service user:\n  sudo -u sandbox-runner /usr/local/bin/sandbox-runner pair"
            .into()
    }
}

fn start_hint() -> String {
    #[cfg(target_os = "windows")]
    {
        "Start the service:\n  sc.exe start sandbox-runner\n  (or use services.msc)".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Start the service:\n  sudo systemctl enable --now sandbox-runner".into()
    }
}

fn logs_hint() -> String {
    #[cfg(target_os = "windows")]
    {
        "Follow service logs (in an elevated PowerShell):\n  Get-WinEvent -LogName 'sandbox-runner' -MaxEvents 200".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Follow service logs:\n  journalctl -u sandbox-runner -f".into()
    }
}

pub fn require_unprivileged(action: &str) -> Result<(), CliError> {
    #[cfg(target_os = "windows")]
    {
        if is_elevated_windows() {
            return Err(CliError::new(
                sbx_code!("1009"),
                format!(
                    "Refusing to {action} from an elevated shell because identity files would end up owned by Administrators."
                ),
                3,
            )
            .help(
                "Open a standard PowerShell as the sandbox-runner service account (or the operator account that owns this workspace) and rerun.",
            ));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if effective_user_id_unix() == Some(0) {
            return Err(CliError::new(
                sbx_code!("1009"),
                format!(
                    "Refusing to {action} as root because identity files would get unsafe ownership."
                ),
                3,
            )
            .help(format!(
                "Run: sudo -u sandbox-runner /usr/local/bin/sandbox-runner {action}"
            )));
        }
    }
    let _ = action;
    Ok(())
}

pub fn require_identity(config: &RunnerConfig) -> Result<(), CliError> {
    let path = config.data_directory.join("identity.json");
    match StoredIdentity::load(&path) {
        Ok(_) => Ok(()),
        Err(_) if !path.exists() => Err(CliError::new(
            sbx_code!("1005"),
            "Runner is not paired, so the service was not started.",
            3,
        )
        .help("Create a token in Account → Operations and run `sandbox-runner pair`.")),
        Err(error) => Err(CliError::new(
            sbx_code!("1006"),
            format!("Runner identity at {} is invalid: {error}", path.display()),
            3,
        )
        .help("Repair its permissions, or revoke the runner and pair a new identity.")),
    }
}

pub fn read_pairing_token(explicit: Option<String>) -> Result<String, CliError> {
    if let Some(token) = explicit.filter(|value| !value.trim().is_empty()) {
        return Ok(token);
    }
    require_terminal("pairing token prompt")?;
    read_secret("Pairing token: ")
}

fn read_secret(label: &str) -> Result<String, CliError> {
    rpassword::prompt_password(label)
        .map(|value| value.trim().to_owned())
        .map_err(|error| {
            CliError::new(
                sbx_code!("1010"),
                format!("Could not open a secure token prompt: {error}"),
                3,
            )
            .help("Pass the token through SANDBOX_PAIRING_TOKEN instead.")
        })
}

fn prompt(label: &str, default: Option<&str>) -> Result<String, CliError> {
    loop {
        match default.filter(|value| !value.is_empty()) {
            Some(value) => print!("{label} [{value}]: "),
            None => print!("{label}: "),
        }
        io::stdout()
            .flush()
            .map_err(|error| CliError::runtime(error.to_string()))?;
        let mut value = String::new();
        io::stdin()
            .read_line(&mut value)
            .map_err(|error| CliError::runtime(error.to_string()))?;
        let value = value.trim();
        if !value.is_empty() {
            return Ok(value.to_owned());
        }
        if let Some(default) = default.filter(|value| !value.is_empty()) {
            return Ok(default.to_owned());
        }
        println!("  A value is required.");
    }
}

fn prompt_choice(label: &str, allowed: &[&str], default: &str) -> Result<String, CliError> {
    loop {
        let value = prompt(&format!("{label} ({})", allowed.join("/")), Some(default))?;
        if allowed.contains(&value.as_str()) {
            return Ok(value);
        }
        println!("  Choose one of: {}.", allowed.join(", "));
    }
}

fn require_terminal(action: &str) -> Result<(), CliError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(CliError::new(
            sbx_code!("1011"),
            format!("{action} requires an interactive terminal."),
            2,
        )
        .help("Use the explicit non-interactive subcommands shown by `sandbox-runner --help`."));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn effective_user_id_unix() -> Option<u32> {
    let output = ProcessCommand::new("id").arg("-u").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()?.trim().parse().ok()
}

#[cfg(target_os = "windows")]
fn is_elevated_windows() -> bool {
    // `net session` needs SeTcbPrivilege / admin token to open the SCM session store;
    // it exits 0 when elevated and non-zero otherwise. Slow (~150ms) but no extra deps.
    ProcessCommand::new("net")
        .arg("session")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub fn enable_virtual_terminal() {
    // Enable ANSI escape processing on conhost. On Windows Terminal / VS Code
    // terminal it's already on; on legacy conhost this flips it. Using
    // GetStdHandle instead of Rust's AsRawHandle avoids the buffered Stdout
    // wrapper (which some spawned-console setups don't back with the real
    // console HANDLE). Failures are silently ignored.
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetStdHandle(std_handle: u32) -> *mut core::ffi::c_void;
            fn GetConsoleMode(handle: *mut core::ffi::c_void, mode: *mut u32) -> i32;
            fn SetConsoleMode(handle: *mut core::ffi::c_void, mode: u32) -> i32;
        }
        const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // -11 as u32
        const ENABLE_PROCESSED_OUTPUT: u32 = 0x0001;
        const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() || handle as isize == -1 {
            return;
        }
        let mut mode: u32 = 0;
        if GetConsoleMode(handle, &mut mode) != 0 {
            let _ = SetConsoleMode(
                handle,
                mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn enable_virtual_terminal() {}

/// RAII guard that swaps the terminal into its alternate screen buffer for the
/// lifetime of a value. Enter clears the screen and hides the cursor; drop
/// leaves the alt buffer and restores the cursor — even on panic, so the
/// user's shell is never left in a garbled state.
struct AltScreen;

impl AltScreen {
    fn enter() -> Self {
        // \x1b[?1049h  enter alternate screen buffer
        // \x1b[?25l    hide cursor
        // \x1b[H       move to top-left
        // \x1b[2J      clear
        print!("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
        let _ = io::stdout().flush();
        AltScreen
    }
}

impl Drop for AltScreen {
    fn drop(&mut self) {
        // \x1b[?25h    show cursor
        // \x1b[?1049l  leave alternate screen buffer
        print!("\x1b[?25h\x1b[?1049l");
        let _ = io::stdout().flush();
    }
}

fn service_state() -> String {
    #[cfg(target_os = "linux")]
    {
        let output = ProcessCommand::new("systemctl")
            .args(["is-active", "sandbox-runner.service"])
            .output();
        match output {
            Ok(result) => {
                let state = String::from_utf8_lossy(&result.stdout).trim().to_owned();
                if state.is_empty() {
                    "not installed".into()
                } else {
                    state
                }
            }
            Err(_) => "unavailable".into(),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let output = ProcessCommand::new("sc")
            .args(["query", "sandbox-runner"])
            .output();
        match output {
            Ok(result) if result.status.success() => {
                let text = String::from_utf8_lossy(&result.stdout);
                if text.contains("RUNNING") {
                    "running".into()
                } else if text.contains("STOPPED") {
                    "stopped".into()
                } else if text.contains("START_PENDING") {
                    "starting".into()
                } else if text.contains("STOP_PENDING") {
                    "stopping".into()
                } else {
                    "installed".into()
                }
            }
            Ok(_) => "not installed".into(),
            Err(_) => "unavailable".into(),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        "unavailable".into()
    }
}

fn colors_enabled() -> bool {
    io::stdout().is_terminal()
        && env::var_os("NO_COLOR").is_none()
        && env::var("TERM").map_or(true, |value| value != "dumb")
}

fn hostname_default() -> String {
    env::var("HOSTNAME")
        .ok()
        .or_else(|| env::var("COMPUTERNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "windows-runner".into()
            } else {
                "linux-runner".into()
            }
        })
}

fn short_id(value: &str) -> &str {
    value.get(..8).unwrap_or(value)
}

fn truncate(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return value.to_owned();
    }
    value
        .chars()
        .take(width.saturating_sub(1))
        .collect::<String>()
        + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(n: &str) -> String {
        let prefix = if cfg!(target_os = "windows") {
            "SBX-WIN-"
        } else {
            "SBX-LNX-"
        };
        format!("{prefix}{n}")
    }

    #[test]
    fn errors_have_stable_code_and_recovery_help() {
        let error = CliError::invalid_input("bad value");
        assert_eq!(error.code, code("1004"));
        assert_eq!(error.exit_code, 2);
        assert!(error.to_string().contains("help:"));
    }

    #[test]
    fn missing_configuration_is_a_named_doctor_failure() {
        let directory = tempfile::tempdir().unwrap();
        let checks = doctor(&directory.path().join("missing.toml"));
        let config = checks
            .iter()
            .find(|check| check.name == "configuration")
            .unwrap();
        assert!(matches!(config.state, CheckState::Fail));
        assert_eq!(config.code.unwrap(), code("1001"));
    }

    #[test]
    fn summary_never_fails_for_an_unconfigured_machine() {
        let directory = tempfile::tempdir().unwrap();
        let summary = runner_summary(&directory.path().join("missing.toml"));
        assert!(!summary.configured);
        assert!(!summary.paired);
    }

    #[test]
    fn long_home_values_are_bounded() {
        assert_eq!(truncate("a-very-long-runner-name", 10), "a-very-lo…");
        assert_eq!(truncate("short", 10), "short");
    }

    #[test]
    fn hermit_crab_animation_has_stable_dimensions() {
        for frame in 0..3 {
            let crab = hermit_crab(frame);
            assert_eq!(crab.len(), 6);
            assert!(crab.iter().all(|line| line.chars().count() <= 35));
        }
    }

    #[test]
    fn home_card_rows_stay_eighty_columns_wide() {
        assert_eq!(card_row("hello", "world").chars().count(), 80);
        assert_eq!(
            card_row(&"x".repeat(100), &"y".repeat(100)).chars().count(),
            80
        );
    }

    #[test]
    fn visible_width_ignores_ansi_escapes() {
        assert_eq!(visible_width("hi"), 2);
        assert_eq!(visible_width("\x1b[38;5;208mhi\x1b[0m"), 2);
        assert_eq!(visible_width("\x1b[2m\x1b[38;5;245mabc\x1b[0m"), 3);
    }

    #[test]
    fn pad_visible_pads_by_visible_length_only() {
        let coloured = "\x1b[38;5;208mhi\x1b[0m";
        let padded = pad_visible(coloured, 6);
        assert_eq!(visible_width(&padded), 6);
        assert!(padded.starts_with("\x1b[38;5;208m"));
    }

    #[test]
    fn body_row_stays_eighty_visible_columns_even_with_colour() {
        let pal = palette(true);
        let left = format!("{}coloured value{}", pal.brand_bright, pal.reset);
        let right = format!("{}another value{}", pal.value, pal.reset);
        let row = body_row(&left, &right, &pal);
        assert_eq!(visible_width(&row), 80);
    }

    #[test]
    fn next_action_advances_with_progress() {
        fn make(configured: bool, paired: bool, service: &str) -> RunnerSummary {
            RunnerSummary {
                version: "test",
                operating_system: "test",
                architecture: "test",
                config_path: String::new(),
                configured,
                config_detail: String::new(),
                runner_name: None,
                environment: None,
                paired,
                runner_id: None,
                service: service.into(),
            }
        }
        // Fresh install → setup is the next action.
        assert_eq!(
            step_states(&make(false, false, "not installed")),
            [StepState::Next, StepState::Pending, StepState::Pending]
        );
        // Configured but unpaired → pair is next.
        assert_eq!(
            step_states(&make(true, false, "not installed")),
            [StepState::Done, StepState::Next, StepState::Pending]
        );
        // Configured + paired but service stopped → start is next.
        assert_eq!(
            step_states(&make(true, true, "stopped")),
            [StepState::Done, StepState::Done, StepState::Next]
        );
        // All the way ready → nothing highlighted as next.
        assert_eq!(
            step_states(&make(true, true, "running")),
            [StepState::Done, StepState::Done, StepState::Done]
        );
    }

    #[test]
    fn only_the_packaged_placeholder_config_is_replaceable_without_force() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        fs::write(
            &config,
            "control_plane_url = \"https://control.example.com\"\nworkspace_id = \"replace-with-workspace-id\"\nenvironment_id = \"replace-with-environment-id\"\n",
        )
        .unwrap();
        assert!(is_packaged_template(&config));
        fs::write(&config, "workspace_id = \"customer-value\"\n").unwrap();
        assert!(!is_packaged_template(&config));
    }

    #[test]
    fn backups_never_overwrite_an_existing_backup() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        assert_eq!(
            next_backup_path(&config),
            directory.path().join("config.toml.bak")
        );
        fs::write(directory.path().join("config.toml.bak"), "first").unwrap();
        assert_eq!(
            next_backup_path(&config),
            directory.path().join("config.toml.bak.1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_config_preserves_its_owner_and_group() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        fs::write(&config, "old configuration").unwrap();
        let before = fs::metadata(&config).unwrap();

        write_config(&config, b"new configuration\n", true).unwrap();

        let after = fs::metadata(&config).unwrap();
        assert_eq!(after.uid(), before.uid());
        assert_eq!(after.gid(), before.gid());
        assert_eq!(fs::read_to_string(config).unwrap(), "new configuration\n");
    }

    #[test]
    fn platform_constants_agree_with_current_target() {
        if cfg!(target_os = "windows") {
            assert_eq!(OS_LABEL, "Windows");
            assert!(DOCS_URL.ends_with("/windows"));
            assert_eq!(PLATFORM_TAG, "windows");
        } else {
            assert_eq!(OS_LABEL, "Linux");
            assert!(DOCS_URL.ends_with("/linux"));
            assert_eq!(PLATFORM_TAG, "linux");
        }
    }
}
