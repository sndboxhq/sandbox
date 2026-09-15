use crate::{EngineError, WorkflowNode};
use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Timelike, Utc};
use cron::Schedule;
use std::str::FromStr;

pub fn next_run(node: &WorkflowNode, after: DateTime<Utc>) -> Result<DateTime<Utc>, EngineError> {
    let kind = node
        .configuration
        .get("scheduleType")
        .and_then(|v| v.as_str())
        .unwrap_or("minutes");
    match kind {
        "minutes" => {
            let every = node
                .configuration
                .get("every")
                .and_then(|v| v.as_i64())
                .unwrap_or(5)
                .clamp(1, 10_080);
            Ok(after + Duration::minutes(every))
        }
        "hourly" => Ok(after + Duration::hours(1)),
        "daily" => {
            let time = NaiveTime::parse_from_str(
                node.configuration
                    .get("time")
                    .and_then(|v| v.as_str())
                    .unwrap_or("09:00"),
                "%H:%M",
            )
            .map_err(|_| EngineError::Validation("Daily schedule time must use HH:MM.".into()))?;
            let today = Utc
                .with_ymd_and_hms(
                    after.year(),
                    after.month(),
                    after.day(),
                    time.hour(),
                    time.minute(),
                    0,
                )
                .single()
                .unwrap();
            Ok(if today > after {
                today
            } else {
                today + Duration::days(1)
            })
        }
        "cron" => {
            let expression = node
                .configuration
                .get("cron")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let normalized = if expression.split_whitespace().count() == 5 {
                format!("0 {expression}")
            } else {
                expression.to_string()
            };
            Schedule::from_str(&normalized)
                .map_err(|_| {
                    EngineError::Validation(
                        "Advanced schedule is not a valid cron expression.".into(),
                    )
                })?
                .after(&after)
                .next()
                .ok_or_else(|| {
                    EngineError::Validation(
                        "Advanced schedule has no future execution time.".into(),
                    )
                })
        }
        _ => Err(EngineError::Validation("Unknown schedule type.".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Position;
    use serde_json::json;
    fn node(config: serde_json::Value) -> WorkflowNode {
        WorkflowNode {
            id: "s".into(),
            node_type: "schedule_trigger".into(),
            version: 1,
            name: "Schedule".into(),
            position: Position { x: 0., y: 0. },
            configuration: config,
            disabled: false,
            input_bindings: Default::default(),
            plugin: None,
            customization: None,
            error_policy: None,
        }
    }
    #[test]
    fn calculates_minutes_and_daily() {
        let now = Utc.with_ymd_and_hms(2026, 8, 26, 10, 30, 0).unwrap();
        assert_eq!(
            next_run(&node(json!({"scheduleType":"minutes","every":15})), now).unwrap(),
            now + Duration::minutes(15)
        );
        assert_eq!(
            next_run(&node(json!({"scheduleType":"daily","time":"09:00"})), now)
                .unwrap()
                .day(),
            27
        );
    }
}
