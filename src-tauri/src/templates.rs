use chrono::Utc;
use sandbox_engine::{
    InputBinding, PermissionSummary, Position, Workflow, WorkflowEdge, WorkflowNode,
    WorkflowSettings, CURRENT_SCHEMA_VERSION,
};
use serde_json::json;
use uuid::Uuid;

fn node(
    id: &str,
    node_type: &str,
    name: &str,
    x: f64,
    y: f64,
    configuration: serde_json::Value,
) -> WorkflowNode {
    WorkflowNode {
        id: id.into(),
        node_type: node_type.into(),
        version: 1,
        name: name.into(),
        position: Position { x, y },
        configuration,
        disabled: false,
        input_bindings: Default::default(),
        plugin: None,
        customization: None,
        error_policy: None,
    }
}
fn edge(id: &str, source: &str, handle: &str, target: &str) -> WorkflowEdge {
    edge_to(id, source, handle, target, "input", Some(handle))
}
fn edge_to(
    id: &str,
    source: &str,
    handle: &str,
    target: &str,
    target_handle: &str,
    source_port: Option<&str>,
) -> WorkflowEdge {
    WorkflowEdge {
        id: id.into(),
        source_node_id: source.into(),
        source_handle: handle.into(),
        target_node_id: target.into(),
        target_handle: target_handle.into(),
        kind: "control".into(),
        source_port: source_port.map(Into::into),
        target_port: Some(target_handle.into()),
    }
}
fn bind_node_output(node: &mut WorkflowNode, field: &str, source: &str, path: &[&str]) {
    node.input_bindings.insert(
        field.into(),
        InputBinding::NodeOutput {
            node_id: source.into(),
            path: path.iter().map(|part| (*part).into()).collect(),
        },
    );
}
fn base(
    name: &str,
    nodes: Vec<WorkflowNode>,
    edges: Vec<WorkflowEdge>,
    trigger: &str,
    permissions: PermissionSummary,
) -> Workflow {
    let now = Utc::now();
    Workflow {
        id: Uuid::new_v4().to_string(),
        schema_version: CURRENT_SCHEMA_VERSION,
        owner: Default::default(),
        name: name.into(),
        description: "".into(),
        enabled: false,
        trigger_node_id: trigger.into(),
        nodes,
        edges,
        settings: WorkflowSettings {
            permissions,
            ..Default::default()
        },
        created_at: now,
        updated_at: now,
    }
}

pub fn blank(name: Option<String>) -> Workflow {
    base(
        name.as_deref().unwrap_or("Untitled workflow"),
        vec![node(
            "manual_trigger",
            "manual_trigger",
            "Manual Trigger",
            80.,
            220.,
            json!({}),
        )],
        vec![],
        "manual_trigger",
        PermissionSummary::default(),
    )
}

pub fn website_health() -> Workflow {
    base(
        "Website Health Monitor",
        vec![
            node(
                "manual_trigger",
                "manual_trigger",
                "Manual Trigger",
                60.,
                220.,
                json!({}),
            ),
            node(
                "http_request",
                "http_request",
                "HTTP Request",
                340.,
                220.,
                json!({"method":"GET","url":"https://example.com","query":{},"headers":{},"body":null,"timeoutMs":30000,"retryCount":1}),
            ),
            node(
                "condition",
                "condition",
                "Condition",
                620.,
                220.,
                json!({"left":"{{nodes.http_request.output.status}}","operator":"equals","right":200}),
            ),
            node(
                "notification_success",
                "desktop_notification",
                "Desktop Notification",
                920.,
                150.,
                json!({"title":"Website is healthy","message":"example.com returned status {{nodes.http_request.output.status}}"}),
            ),
            node(
                "notification_failed",
                "desktop_notification",
                "Desktop Notification",
                920.,
                330.,
                json!({"title":"Website needs attention","message":"example.com returned status {{nodes.http_request.output.status}}"}),
            ),
        ],
        vec![
            edge("e1", "manual_trigger", "output", "http_request"),
            edge("e2", "http_request", "output", "condition"),
            edge("e3", "condition", "true", "notification_success"),
            edge("e4", "condition", "false", "notification_failed"),
        ],
        "manual_trigger",
        PermissionSummary {
            approved_network_domains: vec!["example.com".into()],
            ..Default::default()
        },
    )
}

pub fn downloads_organiser() -> Workflow {
    base(
        "Downloads Folder Organiser",
        vec![
            node(
                "file_watch",
                "file_watch_trigger",
                "File Watch Trigger",
                60.,
                220.,
                json!({"folder":"","events":["created"],"pattern":"*.pdf"}),
            ),
            node(
                "condition",
                "condition",
                "Condition",
                340.,
                220.,
                json!({"left":"{{trigger.extension}}","operator":"equals","right":"pdf"}),
            ),
            node(
                "move_file",
                "move_file",
                "Move File",
                650.,
                150.,
                json!({"source":"{{trigger.path}}","destinationFolder":"","renameTo":"","overwrite":false}),
            ),
        ],
        vec![
            edge("e1", "file_watch", "output", "condition"),
            edge("e2", "condition", "true", "move_file"),
        ],
        "file_watch",
        PermissionSummary::default(),
    )
}

fn accessible_locator(kind: &str, value: &str, name: Option<&str>) -> serde_json::Value {
    json!({
        "primary": { "kind": kind, "value": value, "name": name },
        "alternatives": [],
        "elementRole": if kind == "role" { Some(value) } else { None::<&str> },
        "accessibleName": name,
        "tag": null,
        "stableAttributes": {},
        "frame": null,
        "recordingUrl": null,
        "nearbyText": null
    })
}

pub fn website_change_monitor() -> Workflow {
    base(
        "Website Change Monitor",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Every 30 minutes",
                60.,
                220.,
                json!({"scheduleType":"minutes","every":30,"time":"09:00","cron":"*/30 * * * *"}),
            ),
            node(
                "browser",
                "open_browser",
                "Open monitored browser",
                340.,
                220.,
                json!({"profileId":"","headed":false,"initialUrl":"","viewport":{"width":1280,"height":800},"defaultTimeoutMs":30000,"closeAutomatically":true,"maximumDurationMs":600000}),
            ),
            node(
                "navigate",
                "navigate",
                "Open monitored page",
                620.,
                220.,
                json!({"url":"https://example.com","waitCondition":"dom_ready","timeoutMs":30000}),
            ),
            node(
                "extract",
                "extract_data",
                "Extract page heading",
                900.,
                220.,
                json!({"locator":accessible_locator("role", "heading", Some("Example Domain")),"extract":"text","fieldName":"heading","repeated":false,"timeoutMs":30000}),
            ),
            node(
                "compare",
                "compare_previous",
                "Compare with previous heading",
                1180.,
                220.,
                json!({"key":"website-heading","value":"{{nodes.extract.output.data.heading}}","normalization":"collapse_whitespace"}),
            ),
            node(
                "condition",
                "condition",
                "Heading changed",
                1460.,
                220.,
                json!({"left":"{{nodes.compare.output.changed}}","operator":"equals","right":true}),
            ),
            node(
                "changed",
                "desktop_notification",
                "Notify when changed",
                1740.,
                330.,
                json!({"title":"Website content changed","message":"The monitored heading is now: {{nodes.extract.output.data.heading}}"}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "browser"),
            edge("e2", "browser", "output", "navigate"),
            edge("e3", "navigate", "output", "extract"),
            edge("e4", "extract", "output", "compare"),
            edge("e5", "compare", "output", "condition"),
            edge("e6", "condition", "true", "changed"),
        ],
        "schedule",
        PermissionSummary {
            approved_network_domains: vec!["example.com".into()],
            ..Default::default()
        },
    )
}

pub fn download_daily_report() -> Workflow {
    base(
        "Download Daily Report",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Daily at 09:00",
                60.,
                220.,
                json!({"scheduleType":"daily","every":1,"time":"09:00","cron":"0 9 * * *"}),
            ),
            node(
                "browser",
                "open_browser",
                "Open reporting profile",
                340.,
                220.,
                json!({"profileId":"","headed":false,"initialUrl":"","viewport":{"width":1280,"height":800},"defaultTimeoutMs":30000,"closeAutomatically":true,"maximumDurationMs":900000}),
            ),
            node(
                "navigate",
                "navigate",
                "Open report portal",
                620.,
                220.,
                json!({"url":"https://example.com","waitCondition":"dom_ready","timeoutMs":30000}),
            ),
            node(
                "fill",
                "fill_field",
                "Fill account email",
                900.,
                220.,
                json!({"locator":accessible_locator("label", "Email address", Some("Email address")),"value":"","clearExisting":true,"inputDelayMs":0,"sensitive":false,"timeoutMs":30000}),
            ),
            node(
                "click",
                "click_element",
                "Open reports",
                1180.,
                220.,
                json!({"locator":accessible_locator("role", "button", Some("Open reports")),"clickType":"normal","mouseButton":"left","modifiers":[],"waitAfterMs":500,"timeoutMs":30000}),
            ),
            node(
                "download",
                "download_file",
                "Download report",
                1460.,
                220.,
                json!({"locator":accessible_locator("role", "button", Some("Download report")),"destinationFolder":"","filename":"daily-report.csv","collisionBehaviour":"rename","maximumBytes":104857600,"timeoutMs":60000}),
            ),
            node(
                "parse",
                "parse_csv",
                "Parse downloaded report",
                1740.,
                220.,
                json!({"path":"{{nodes.download.output.path}}","content":"","delimiter":",","hasHeaders":true,"trim":true}),
            ),
            node(
                "condition",
                "condition",
                "Report contains rows",
                2020.,
                220.,
                json!({"left":"{{nodes.parse.output.rowCount}}","operator":"greater_than","right":0}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Report ready",
                2300.,
                220.,
                json!({"title":"Daily report ready","message":"Verified {{nodes.parse.output.rowCount}} rows in {{nodes.download.output.filename}}"}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "browser"),
            edge("e2", "browser", "output", "navigate"),
            edge("e3", "navigate", "output", "fill"),
            edge("e4", "fill", "output", "click"),
            edge("e5", "click", "output", "download"),
            edge("e6", "download", "output", "parse"),
            edge("e7", "parse", "output", "condition"),
            edge("e8", "condition", "true", "notification"),
        ],
        "schedule",
        PermissionSummary {
            approved_network_domains: vec!["example.com".into()],
            ..Default::default()
        },
    )
}

pub fn email_enquiry_draft() -> Workflow {
    base(
        "Email Enquiry Draft",
        vec![
            node(
                "new_email",
                "gmail_new_email_trigger",
                "New enquiry email",
                60.,
                220.,
                json!({"credentialId":"","pollIntervalMinutes":5,"sender":"","recipient":"","subjectContains":"enquiry","hasAttachment":false,"label":"","includeHtmlBody":false,"markAsProcessed":"deduplicate"}),
            ),
            node(
                "condition",
                "condition",
                "Has a sender",
                340.,
                220.,
                json!({"left":"{{trigger.email.sender}}","operator":"exists","right":null}),
            ),
            node(
                "compose",
                "set_data",
                "Prepare acknowledgement",
                620.,
                150.,
                json!({"values":{"recipient":"{{trigger.email.sender}}","subject":"Re: {{trigger.email.subject}}","body":"Thanks for your enquiry. We have received your message and will respond shortly."}}),
            ),
            node(
                "draft",
                "gmail_create_draft",
                "Create Gmail draft",
                900.,
                150.,
                json!({"credentialId":"","to":"{{nodes.compose.output.recipient}}","cc":"","bcc":"","subject":"{{nodes.compose.output.subject}}","body":"{{nodes.compose.output.body}}","htmlBody":"","replyToMessage":"{{trigger.email.messageId}}"}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Draft ready",
                1180.,
                150.,
                json!({"title":"Email draft ready","message":"A draft reply to {{trigger.email.sender}} is ready in Gmail."}),
            ),
        ],
        vec![
            edge("e1", "new_email", "output", "condition"),
            edge("e2", "condition", "true", "compose"),
            edge("e3", "compose", "output", "draft"),
            edge("e4", "draft", "output", "notification"),
        ],
        "new_email",
        PermissionSummary::default(),
    )
}

pub fn website_status_discord() -> Workflow {
    base(
        "Website Status to Discord",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Every 15 minutes",
                60.,
                220.,
                json!({"scheduleType":"minutes","every":15,"time":"09:00","cron":"*/15 * * * *"}),
            ),
            node(
                "request",
                "http_request",
                "Check website",
                340.,
                220.,
                json!({"method":"GET","url":"https://example.com","query":{},"headers":{},"body":null,"timeoutMs":30000,"retryCount":1}),
            ),
            node(
                "condition",
                "condition",
                "Status is healthy",
                620.,
                220.,
                json!({"left":"{{nodes.request.output.status}}","operator":"equals","right":200}),
            ),
            node(
                "discord",
                "discord_webhook",
                "Alert Discord",
                900.,
                330.,
                json!({"credentialId":"","content":"Website check failed with HTTP {{nodes.request.output.status}}.","username":"sndbox monitor","avatarUrl":""}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "request"),
            edge("e2", "request", "output", "condition"),
            edge("e3", "condition", "false", "discord"),
        ],
        "schedule",
        PermissionSummary {
            approved_network_domains: vec!["example.com".into()],
            ..Default::default()
        },
    )
}

pub fn api_change_alert() -> Workflow {
    base(
        "API Change Alert",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Every 30 minutes",
                60.,
                220.,
                json!({"scheduleType":"minutes","every":30,"time":"09:00","cron":"*/30 * * * *"}),
            ),
            node(
                "request",
                "http_request",
                "Fetch API response",
                340.,
                220.,
                json!({"method":"GET","url":"https://api.github.com/zen","query":{},"headers":{"Accept":"application/json"},"body":null,"timeoutMs":30000,"retryCount":1}),
            ),
            node(
                "compare",
                "compare_previous",
                "Compare response",
                620.,
                220.,
                json!({"key":"api-response","value":"{{nodes.request.output.body}}","normalization":"collapse_whitespace"}),
            ),
            node(
                "condition",
                "condition",
                "Response changed",
                900.,
                220.,
                json!({"left":"{{nodes.compare.output.changed}}","operator":"equals","right":true}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Notify change",
                1180.,
                150.,
                json!({"title":"API response changed","message":"The monitored API returned a different response."}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "request"),
            edge("e2", "request", "output", "compare"),
            edge("e3", "compare", "output", "condition"),
            edge("e4", "condition", "true", "notification"),
        ],
        "schedule",
        PermissionSummary {
            approved_network_domains: vec!["api.github.com".into()],
            background_execution_permitted: true,
            ..Default::default()
        },
    )
}

pub fn slack_incident_alert() -> Workflow {
    base(
        "Slack Incident Alert",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Every 5 minutes",
                60.,
                220.,
                json!({"scheduleType":"minutes","every":5,"time":"09:00","cron":"*/5 * * * *"}),
            ),
            node(
                "request",
                "http_request",
                "Check service",
                340.,
                220.,
                json!({"method":"GET","url":"https://example.com","query":{},"headers":{},"body":null,"timeoutMs":15000,"retryCount":2}),
            ),
            node(
                "condition",
                "condition",
                "Service is healthy",
                620.,
                220.,
                json!({"left":"{{nodes.request.output.status}}","operator":"equals","right":200}),
            ),
            node(
                "slack",
                "slack_webhook",
                "Post incident",
                900.,
                330.,
                json!({"credentialId":"","content":"Service check failed with HTTP {{nodes.request.output.status}}."}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "request"),
            edge("e2", "request", "output", "condition"),
            edge("e3", "condition", "false", "slack"),
        ],
        "schedule",
        PermissionSummary {
            approved_network_domains: vec!["example.com".into()],
            background_execution_permitted: true,
            external_communication_permitted: true,
            ..Default::default()
        },
    )
}

pub fn ai_email_triage() -> Workflow {
    base(
        "AI Email Triage",
        vec![
            node(
                "new_email",
                "gmail_new_email_trigger",
                "New inbox email",
                60.,
                220.,
                json!({"credentialId":"","pollIntervalMinutes":5,"sender":"","recipient":"","subjectContains":"","hasAttachment":false,"label":"","includeHtmlBody":false,"markAsProcessed":"deduplicate"}),
            ),
            node(
                "ai",
                "ai_prompt",
                "Classify and draft reply",
                340.,
                220.,
                json!({"connectionId":"","systemPrompt":"You triage incoming email. Return a concise, courteous draft reply only.","prompt":"Draft a reply to this email from {{trigger.email.sender}}. Subject: {{trigger.email.subject}}\n\n{{trigger.email.body}}","temperature":0.2,"maxTokens":900,"timeoutMs":90000}),
            ),
            node(
                "draft",
                "gmail_create_draft",
                "Create reviewed draft",
                620.,
                220.,
                json!({"credentialId":"","to":"{{trigger.email.sender}}","cc":"","bcc":"","subject":"Re: {{trigger.email.subject}}","body":"{{nodes.ai.output.response}}","htmlBody":"","replyToMessage":"{{trigger.email.messageId}}"}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Draft ready",
                900.,
                220.,
                json!({"title":"AI email draft ready","message":"Review the draft reply to {{trigger.email.sender}} in Gmail."}),
            ),
        ],
        vec![
            edge("e1", "new_email", "output", "ai"),
            edge("e2", "ai", "output", "draft"),
            edge("e3", "draft", "output", "notification"),
        ],
        "new_email",
        PermissionSummary {
            background_execution_permitted: true,
            external_communication_permitted: true,
            ..Default::default()
        },
    )
}

pub fn ai_daily_brief() -> Workflow {
    base(
        "AI Daily Brief",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Weekdays at 08:30",
                60.,
                220.,
                json!({"scheduleType":"cron","every":1,"time":"08:30","cron":"30 8 * * 1-5"}),
            ),
            node(
                "ai",
                "ai_prompt",
                "Write daily brief",
                340.,
                220.,
                json!({"connectionId":"","systemPrompt":"You are a focused planning assistant. Be concise and action oriented.","prompt":"Create a short daily brief with three priorities, one risk to watch, and a first action.","temperature":0.4,"maxTokens":700,"timeoutMs":90000}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Show daily brief",
                620.,
                220.,
                json!({"title":"Your AI daily brief","message":"{{nodes.ai.output.response}}"}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "ai"),
            edge("e2", "ai", "output", "notification"),
        ],
        "schedule",
        PermissionSummary {
            background_execution_permitted: true,
            ..Default::default()
        },
    )
}

pub fn ai_command_assistant() -> Workflow {
    base(
        "AI Command Assistant",
        vec![
            node(
                "manual_trigger",
                "manual_trigger",
                "Manual Trigger",
                60.,
                220.,
                json!({}),
            ),
            node(
                "command",
                "run_command",
                "Inspect repository status",
                340.,
                220.,
                json!({"executable":"git","arguments":["status","--short"],"workingDirectory":"","timeoutMs":30000}),
            ),
            node(
                "ai",
                "ai_prompt",
                "Explain command output",
                620.,
                220.,
                json!({"connectionId":"","systemPrompt":"You explain command output accurately and suggest safe next steps.","prompt":"Explain this command result and list any action needed. Exit code: {{nodes.command.output.exitCode}}\n\n{{nodes.command.output.stdout}}\n{{nodes.command.output.stderr}}","temperature":0.2,"maxTokens":900,"timeoutMs":90000}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Show explanation",
                900.,
                220.,
                json!({"title":"Command analysis complete","message":"{{nodes.ai.output.response}}"}),
            ),
        ],
        vec![
            edge("e1", "manual_trigger", "output", "command"),
            edge("e2", "command", "output", "ai"),
            edge("e3", "ai", "output", "notification"),
        ],
        "manual_trigger",
        PermissionSummary {
            command_execution_permitted: true,
            ..Default::default()
        },
    )
}

pub fn localhost_status_site() -> Workflow {
    let mut site = node(
        "site",
        "web_builder",
        "Serve localhost site",
        650.,
        250.,
        json!({"html":"","javascript":"","css":"","port":0,"openBrowser":true}),
    );
    bind_node_output(&mut site, "html", "html", &["code"]);
    bind_node_output(&mut site, "javascript", "javascript", &["code"]);
    bind_node_output(&mut site, "css", "css", &["code"]);
    base(
        "Localhost Status Site",
        vec![
            node(
                "manual_trigger",
                "manual_trigger",
                "Manual Trigger",
                40.,
                250.,
                json!({}),
            ),
            node(
                "html",
                "code",
                "Status page HTML",
                320.,
                80.,
                json!({"language":"html","executionMode":"source","timeoutMs":30000,"sourceCode":r#"<main class="shell"><header><span class="pulse"></span><div><p>LOCAL MONITOR</p><h1>Systems operational</h1></div></header><section id="services"></section><footer>Updated <time id="updated">now</time></footer></main>"#}),
            ),
            node(
                "javascript",
                "code",
                "Status page JavaScript",
                320.,
                250.,
                json!({"language":"javascript","executionMode":"source","timeoutMs":30000,"sourceCode":"const services = ['API', 'Website', 'Database'];\nconst root = document.querySelector('#services');\nroot.innerHTML = services.map(name => `<article><span>${name}</span><b>Operational</b></article>`).join('');\ndocument.querySelector('#updated').textContent = new Date().toLocaleTimeString();"}),
            ),
            node(
                "css",
                "code",
                "Status page CSS",
                320.,
                420.,
                json!({"language":"css","executionMode":"source","timeoutMs":30000,"sourceCode":":root{font-family:Inter,system-ui;color:#eef1f5;background:#090b10}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#172033,#090b10 55%)}.shell{width:min(680px,calc(100% - 40px))}header{display:flex;align-items:center;gap:16px;margin-bottom:28px}.pulse{width:14px;height:14px;border-radius:50%;background:#62d994;box-shadow:0 0 0 8px #62d99418}p,footer{color:#7e899b;font-size:12px;letter-spacing:.14em}h1{margin:4px 0 0;font-size:34px}section{display:grid;gap:10px}article{display:flex;justify-content:space-between;padding:18px 20px;border:1px solid #273145;border-radius:12px;background:#111722cc}article b{color:#62d994;font-size:13px}footer{margin-top:18px;text-align:right}"}),
            ),
            site,
        ],
        vec![
            edge("e1", "manual_trigger", "output", "html"),
            edge("e2", "manual_trigger", "output", "javascript"),
            edge("e3", "manual_trigger", "output", "css"),
            edge_to("e4", "html", "output", "site", "html", Some("code")),
            edge_to(
                "e5",
                "javascript",
                "output",
                "site",
                "javascript",
                Some("code"),
            ),
            edge_to("e6", "css", "output", "site", "css", Some("code")),
        ],
        "manual_trigger",
        PermissionSummary::default(),
    )
}

pub fn scheduled_screenshot() -> Workflow {
    base(
        "Scheduled Website Screenshot",
        vec![
            node(
                "schedule",
                "schedule_trigger",
                "Daily at 09:00",
                60.,
                220.,
                json!({"scheduleType":"daily","every":1,"time":"09:00","cron":"0 9 * * *"}),
            ),
            node(
                "browser",
                "open_browser",
                "Open browser",
                340.,
                220.,
                json!({"profileId":"","headed":false,"initialUrl":"","viewport":{"width":1440,"height":900},"defaultTimeoutMs":30000,"closeAutomatically":true,"keepOpenAfterManualTest":false,"maximumDurationMs":600000}),
            ),
            node(
                "navigate",
                "navigate",
                "Open website",
                620.,
                220.,
                json!({"url":"https://example.com","waitCondition":"network_idle","timeoutMs":30000}),
            ),
            node(
                "screenshot",
                "screenshot",
                "Capture full page",
                900.,
                220.,
                json!({"mode":"full_page","includeInHistory":true,"maximumBytes":10485760,"timeoutMs":30000}),
            ),
            node(
                "close",
                "close_browser",
                "Close browser",
                1180.,
                220.,
                json!({}),
            ),
        ],
        vec![
            edge("e1", "schedule", "output", "browser"),
            edge("e2", "browser", "output", "navigate"),
            edge("e3", "navigate", "output", "screenshot"),
            edge("e4", "screenshot", "output", "close"),
        ],
        "schedule",
        PermissionSummary {
            approved_network_domains: vec!["example.com".into()],
            browser_automation_permitted: true,
            background_execution_permitted: true,
            ..Default::default()
        },
    )
}

pub fn json_file_summary() -> Workflow {
    base(
        "AI JSON File Summary",
        vec![
            node(
                "manual_trigger",
                "manual_trigger",
                "Manual Trigger",
                60.,
                220.,
                json!({}),
            ),
            node(
                "read",
                "read_file",
                "Read JSON file",
                340.,
                220.,
                json!({"path":"","encoding":"utf8","maximumBytes":10485760}),
            ),
            node(
                "parse",
                "parse_json",
                "Parse JSON",
                620.,
                220.,
                json!({"path":"","content":"{{nodes.read.output.content}}"}),
            ),
            node(
                "ai",
                "ai_prompt",
                "Summarize JSON",
                900.,
                220.,
                json!({"connectionId":"","systemPrompt":"You summarize structured data accurately and call out missing or unusual values.","prompt":"Summarize the important fields and anomalies in this JSON:\n{{nodes.parse.output.value}}","temperature":0.2,"maxTokens":1000,"timeoutMs":90000}),
            ),
            node(
                "notification",
                "desktop_notification",
                "Show summary",
                1180.,
                220.,
                json!({"title":"JSON summary ready","message":"{{nodes.ai.output.response}}"}),
            ),
        ],
        vec![
            edge("e1", "manual_trigger", "output", "read"),
            edge("e2", "read", "output", "parse"),
            edge("e3", "parse", "output", "ai"),
            edge("e4", "ai", "output", "notification"),
        ],
        "manual_trigger",
        PermissionSummary::default(),
    )
}

pub fn approval_email() -> Workflow {
    base(
        "Approval-Gated Email",
        vec![
            node(
                "manual_trigger",
                "manual_trigger",
                "Manual Trigger",
                60.,
                220.,
                json!({}),
            ),
            node(
                "compose",
                "set_data",
                "Compose message",
                340.,
                220.,
                json!({"values":{"recipient":"person@example.com","subject":"Status update","body":"Write your reviewed message here."}}),
            ),
            node(
                "approval",
                "approval",
                "Approve send",
                620.,
                220.,
                json!({"proposedAction":"Send a Gmail message","recipient":"{{nodes.compose.output.recipient}}","subject":"{{nodes.compose.output.subject}}","messagePreview":"{{nodes.compose.output.body}}","attachments":[],"expiresInMinutes":60}),
            ),
            node(
                "send",
                "gmail_send_email",
                "Send approved email",
                900.,
                220.,
                json!({"credentialId":"","to":"{{nodes.compose.output.recipient}}","cc":"","bcc":"","subject":"{{nodes.compose.output.subject}}","body":"{{nodes.compose.output.body}}","htmlBody":"","replyToMessage":"","attachments":[]}),
            ),
        ],
        vec![
            edge("e1", "manual_trigger", "output", "compose"),
            edge("e2", "compose", "output", "approval"),
            edge("e3", "approval", "output", "send"),
        ],
        "manual_trigger",
        PermissionSummary {
            external_communication_permitted: true,
            ..Default::default()
        },
    )
}

pub fn by_key(key: &str, name: Option<String>) -> Workflow {
    let mut workflow = match key {
        "website-health" => website_health(),
        "website-change-monitor" => website_change_monitor(),
        "download-daily-report" => download_daily_report(),
        "email-enquiry-draft" => email_enquiry_draft(),
        "website-status-discord" => website_status_discord(),
        "downloads-organiser" => downloads_organiser(),
        "api-change-alert" => api_change_alert(),
        "slack-incident-alert" => slack_incident_alert(),
        "ai-email-triage" => ai_email_triage(),
        "ai-daily-brief" => ai_daily_brief(),
        "ai-command-assistant" => ai_command_assistant(),
        "localhost-status-site" => localhost_status_site(),
        "scheduled-screenshot" => scheduled_screenshot(),
        "json-file-summary" => json_file_summary(),
        "approval-email" => approval_email(),
        "browser-automation" | "report-collection" => download_daily_report(),
        "file-folder-automation" => downloads_organiser(),
        "website-monitoring" => website_change_monitor(),
        "developer-workflows" => website_health(),
        "homelab-automation" => website_status_discord(),
        _ => blank(name.clone()),
    };
    if let Some(name) = name {
        workflow.name = name;
    }
    workflow
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREMADE_KEYS: [&str; 15] = [
        "localhost-status-site",
        "ai-email-triage",
        "website-change-monitor",
        "api-change-alert",
        "website-health",
        "website-status-discord",
        "slack-incident-alert",
        "email-enquiry-draft",
        "approval-email",
        "ai-daily-brief",
        "ai-command-assistant",
        "scheduled-screenshot",
        "download-daily-report",
        "downloads-organiser",
        "json-file-summary",
    ];

    #[test]
    fn every_premade_key_creates_a_real_graph_and_uses_the_requested_name() {
        for key in PREMADE_KEYS {
            let workflow = by_key(key, Some(format!("Copy of {key}")));
            assert_eq!(workflow.name, format!("Copy of {key}"));
            assert!(workflow.nodes.len() > 1, "{key} fell back to blank");
            assert!(!workflow.edges.is_empty(), "{key} has no connections");
        }
    }

    #[test]
    fn localhost_site_has_three_named_code_inputs() {
        let workflow = localhost_status_site();
        let site = workflow
            .nodes
            .iter()
            .find(|candidate| candidate.id == "site")
            .expect("web builder node");
        assert_eq!(site.input_bindings.len(), 3);
        for port in ["html", "javascript", "css"] {
            assert!(site.input_bindings.contains_key(port));
            assert!(workflow
                .edges
                .iter()
                .any(|edge| edge.target_node_id == "site" && edge.target_handle == port));
        }
    }
}
