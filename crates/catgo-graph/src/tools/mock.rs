use async_trait::async_trait;
use std::sync::atomic::{AtomicU32, Ordering};
use crate::core::*;
use crate::graph::run::ToolExecutionResult;
use crate::tools::traits::{Tool, ToolExecutionContext};

/// EchoTool: echoes all inputs as outputs. Always succeeds.
pub struct EchoTool {
    tool_name: String,
}

impl EchoTool {
    pub fn new(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
        }
    }
}

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        Ok(ToolExecutionResult {
            outputs: inputs,
            artifacts: vec![],
            logs: vec![format!(
                "[{}] echo completed for node {}",
                self.tool_name, ctx.node_id
            )],
            metadata: Default::default(),
        })
    }
}

/// FailTool: always fails with a structured error.
pub struct FailTool {
    tool_name: String,
    retryable: bool,
}

impl FailTool {
    pub fn new(name: &str, retryable: bool) -> Self {
        Self {
            tool_name: name.to_string(),
            retryable,
        }
    }
}

#[async_trait]
impl Tool for FailTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        _inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        Err(StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("MOCK_FAIL".into()),
            message: format!("{} always fails", self.tool_name),
            retryable: self.retryable,
            details: serde_json::json!({}),
        })
    }
}

/// FlakeyTool: fails N times, then succeeds. Great for testing retry logic.
pub struct FlakeyTool {
    tool_name: String,
    fail_count: AtomicU32,
    fail_until: u32,
}

impl FlakeyTool {
    pub fn new(name: &str, fail_until: u32) -> Self {
        Self {
            tool_name: name.to_string(),
            fail_count: AtomicU32::new(0),
            fail_until,
        }
    }
}

#[async_trait]
impl Tool for FlakeyTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let count = self.fail_count.fetch_add(1, Ordering::SeqCst);
        if count < self.fail_until {
            Err(StructuredError {
                category: ErrorCategory::ExternalProcess,
                code: Some("TRANSIENT".into()),
                message: format!("Transient failure {}/{}", count + 1, self.fail_until),
                retryable: true,
                details: serde_json::json!({}),
            })
        } else {
            Ok(ToolExecutionResult {
                outputs: inputs,
                artifacts: vec![],
                logs: vec![format!(
                    "[{}] succeeded after {} failures",
                    self.tool_name, self.fail_until
                )],
                metadata: Default::default(),
            })
        }
    }
}

/// DelayTool: succeeds after a configurable delay. Tests parallel execution timing.
pub struct DelayTool {
    tool_name: String,
    delay_ms: u64,
}

impl DelayTool {
    pub fn new(name: &str, delay_ms: u64) -> Self {
        Self {
            tool_name: name.to_string(),
            delay_ms,
        }
    }
}

#[async_trait]
impl Tool for DelayTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        _ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
        Ok(ToolExecutionResult {
            outputs: inputs,
            artifacts: vec![],
            logs: vec![format!(
                "[{}] completed after {}ms",
                self.tool_name, self.delay_ms
            )],
            metadata: Default::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-001".to_string(),
            node_id: "node-A".to_string(),
            attempt_index: 0,
            work_dir: "/tmp/test".to_string(),
        }
    }

    #[tokio::test]
    async fn test_echo_tool_echoes_inputs() {
        let tool = EchoTool::new("echo");
        let inputs = serde_json::json!({"x": 42, "name": "hello"});
        let result = tool.execute(test_ctx(), inputs.clone()).await.unwrap();

        assert_eq!(result.outputs, inputs);
        assert!(result.artifacts.is_empty());
        assert_eq!(result.logs.len(), 1);
        assert!(result.logs[0].contains("echo completed for node node-A"));
    }

    #[tokio::test]
    async fn test_echo_tool_name() {
        let tool = EchoTool::new("my_echo");
        assert_eq!(tool.name(), "my_echo");
    }

    #[tokio::test]
    async fn test_fail_tool_returns_error() {
        let tool = FailTool::new("always_fail", false);
        let result = tool.execute(test_ctx(), serde_json::json!({})).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.category, ErrorCategory::ToolInvocation);
        assert_eq!(err.code, Some("MOCK_FAIL".to_string()));
        assert!(!err.retryable);
        assert!(err.message.contains("always_fail"));
    }

    #[tokio::test]
    async fn test_fail_tool_retryable() {
        let tool = FailTool::new("retry_fail", true);
        let err = tool
            .execute(test_ctx(), serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(err.retryable);
    }

    #[tokio::test]
    async fn test_flakey_tool_fails_then_succeeds() {
        let tool = FlakeyTool::new("flakey", 3);

        // First 3 calls should fail
        for i in 0..3 {
            let result = tool.execute(test_ctx(), serde_json::json!({})).await;
            assert!(result.is_err(), "Call {} should fail", i);
            let err = result.unwrap_err();
            assert!(err.retryable);
            assert_eq!(err.category, ErrorCategory::ExternalProcess);
        }

        // 4th call should succeed
        let result = tool
            .execute(test_ctx(), serde_json::json!({"data": "value"}))
            .await;
        assert!(result.is_ok(), "Call 4 should succeed");
        let ok = result.unwrap();
        assert_eq!(ok.outputs, serde_json::json!({"data": "value"}));
        assert!(ok.logs[0].contains("succeeded after 3 failures"));
    }

    #[tokio::test]
    async fn test_flakey_tool_zero_failures_succeeds_immediately() {
        let tool = FlakeyTool::new("instant", 0);
        let result = tool
            .execute(test_ctx(), serde_json::json!({"ok": true}))
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_delay_tool_completes() {
        let tool = DelayTool::new("slow", 10);
        let inputs = serde_json::json!({"step": 1});
        let result = tool.execute(test_ctx(), inputs.clone()).await.unwrap();

        assert_eq!(result.outputs, inputs);
        assert!(result.logs[0].contains("completed after 10ms"));
    }

    #[tokio::test]
    async fn test_delay_tool_parallel_execution() {
        let tool_a = DelayTool::new("a", 50);
        let tool_b = DelayTool::new("b", 50);

        let start = tokio::time::Instant::now();
        let (ra, rb) = tokio::join!(
            tool_a.execute(test_ctx(), serde_json::json!({})),
            tool_b.execute(test_ctx(), serde_json::json!({})),
        );
        let elapsed = start.elapsed();

        assert!(ra.is_ok());
        assert!(rb.is_ok());
        // Both ran in parallel, so total time should be close to 50ms, not 100ms
        assert!(
            elapsed.as_millis() < 120,
            "Parallel execution took {}ms, expected < 120ms",
            elapsed.as_millis()
        );
    }
}
