//! AI 服务底座（Prompt 4 前置）
//!
//! 职责：
//! 1. 模型配置（DeepSeek V4 Flash/Pro + Kimi K2.7，OpenAI 兼容）
//! 2. API Key 安全存储（系统凭据管理器 keyring，绝不明文落盘/进 Git）
//! 3. chat 补全 API（reqwest + SSE 流式），供翻译/聊天/AI 重排复用
//! 4. 连接测试 + 错误码映射（对齐工程补充文档 §3.1）
//!
//! 安全约定：
//! - API Key 只存 keyring（Windows Credential Manager），不出现在任何
//!   settings.json / 日志 / 错误消息中
//! - 所有错误消息先经 redact() 脱敏（sk-xxx 替换为 ***）

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub mod translate;

// ========== 模型配置 ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    /// 应用内唯一 ID
    pub id: String,
    /// 显示名
    pub label: String,
    /// provider：deepseek | kimi
    pub provider: String,
    /// 实际发给 API 的模型名（可在设置面板修改，服务商改名后免升级）
    pub api_model: String,
    /// API base URL（不含 /chat/completions）
    pub base_url: String,
    /// 上下文窗口（tokens）
    pub context_window: u32,
    /// 单次输出上限（tokens）。翻译分批按此反推，避免输出被截断。
    /// 旧 settings.json 无此字段时默认 8000。
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
    /// 采样温度。部分服务强制要求特定值（如 Kimi for Coding 只允许 1），
    /// 因此按模型可配置。旧 settings.json 无此字段时默认 0.2。
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    /// 输入价格（USD / 1M tokens）
    pub price_input: f64,
    /// 输出价格（USD / 1M tokens）
    pub price_output: f64,
}

fn default_max_output_tokens() -> u32 {
    8000
}

fn default_temperature() -> f64 {
    0.2
}

fn default_models() -> Vec<ModelConfig> {
    vec![
        ModelConfig {
            id: "deepseek-v4-flash".into(),
            label: "DeepSeek V4 Flash".into(),
            provider: "deepseek".into(),
            // 官方兼容名（指向 V4 系列）；如 404 请在设置面板改为最新模型名
            api_model: "deepseek-chat".into(),
            base_url: "https://api.deepseek.com".into(),
            context_window: 1_000_000,
            max_output_tokens: 8000,
            temperature: 0.2,
            price_input: 0.14,
            price_output: 0.28,
        },
        ModelConfig {
            id: "deepseek-v4-pro".into(),
            label: "DeepSeek V4 Pro".into(),
            provider: "deepseek".into(),
            api_model: "deepseek-reasoner".into(),
            base_url: "https://api.deepseek.com".into(),
            context_window: 1_000_000,
            max_output_tokens: 8000,
            temperature: 0.2,
            price_input: 0.435,
            price_output: 0.87,
        },
        ModelConfig {
            id: "kimi-k3".into(),
            label: "Kimi K3（开放平台）".into(),
            provider: "kimi".into(),
            api_model: "kimi-k3".into(),
            base_url: "https://api.moonshot.cn/v1".into(),
            context_window: 1_000_000,
            max_output_tokens: 8192,
            temperature: 0.2,
            // ¥20 / ¥100 per MTok ≈ $2.8 / $14（仅成本估算展示）
            price_input: 2.8,
            price_output: 14.0,
        },
        ModelConfig {
            id: "kimi-code".into(),
            label: "Kimi for Coding（会员订阅）".into(),
            provider: "kimi-code".into(),
            // Kimi Code 与开放平台是两套独立系统：Key 和 Base URL 均不通用。
            // OpenAI 兼容端点：https://api.kimi.com/coding/v1
            // 模型 ID：kimi-for-coding（普通版）/ kimi-for-coding-highspeed（高速版，需 Allegretto+）
            api_model: "kimi-for-coding".into(),
            base_url: "https://api.kimi.com/coding/v1".into(),
            context_window: 256_000,
            max_output_tokens: 8192,
            // Kimi for Coding 官方强制 temperature=1，其他值直接 400 拒绝
            temperature: 1.0,
            // 会员订阅制，不按量计费 → 成本估算为 0
            price_input: 0.0,
            price_output: 0.0,
        },
    ]
}

/// 配置状态（不含 Key 本身！Key 只在 keyring 里）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub models: Vec<ModelConfig>,
    pub default_model: String,
    /// 各 provider 的 Key 是否已配置
    pub keys: Vec<ProviderKeyStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider: String,
    pub configured: bool,
}

// ========== 设置文件（不含 key） ==========

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    default_model: String,
}

impl Default for SettingsFile {
    fn default() -> Self {
        SettingsFile {
            default_model: "deepseek-v4-flash".to_string(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::env_manager::app_data_dir(app)?;
    Ok(dir.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> SettingsFile {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return SettingsFile::default(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &SettingsFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入设置失败: {}", e))
}

// ========== Key 安全存储（keyring） ==========

/// keyring service 名（应用级）
const KEYRING_SERVICE: &str = "com.paperreader.app";

/// 存 Key 到系统凭据管理器。成功后 Key 只存在于 Credential Manager，
/// 任何 settings.json / Git 都不会出现。
pub fn keychain_set(provider: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| format!("保存 API Key 失败: {}", e))
}

/// 读取 Key。不存在返回 Ok(None)
pub(crate) fn keychain_get(provider: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 API Key 失败: {}", e)),
    }
}

pub fn keychain_remove(provider: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除 API Key 失败: {}", e)),
    }
}

// ========== 脱敏 ==========

/// 错误消息脱敏：把形如 sk-xxx 的 Key 片段替换为 ***，防止泄漏。
/// 不用正则，直接字符串查找替换（轻量、无依赖）。
pub(crate) fn redact(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut rest = msg;
    while let Some(pos) = rest.find("sk-") {
        out.push_str(&rest[..pos]);
        out.push_str("sk-***");
        let after = &rest[pos + 3..];
        // 跳过 key 本体（sk- 后连续的字母数字中划线下划线）
        let skip = after
            .char_indices()
            .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_'))
            .map(|(i, _)| i)
            .unwrap_or(after.len());
        rest = &after[skip..];
    }
    out.push_str(rest);
    out
}

// ========== chat 补全 ==========

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String, // system | user | assistant
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub text: String,
    pub model: String,
    pub usage: Option<ChatUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// SSE 流式事件名（前端 listen）
pub const AI_CHUNK_EVENT: &str = "ai-chunk";

pub(crate) fn model_by_id(id: &str) -> Option<ModelConfig> {
    default_models().into_iter().find(|m| m.id == id)
}

/// 调用 chat API。stream=true 时经 SSE 逐段 emit `ai-chunk` 事件。
#[tauri::command]
pub async fn chat_completion(
    app: AppHandle,
    prompt: String,
    system: Option<String>,
    model_id: String,
    stream: bool,
) -> Result<ChatResult, String> {
    let model = model_by_id(&model_id).ok_or_else(|| format!("未知模型: {}", model_id))?;
    let key = keychain_get(&model.provider)?
        .ok_or_else(|| format!("KEY_NOT_SET:{}", model.provider))?;

    let mut messages = Vec::new();
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        messages.push(ChatMessage { role: "system".into(), content: sys });
    }
    messages.push(ChatMessage { role: "user".into(), content: prompt });

    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", model.base_url);
    let body = serde_json::json!({
        "model": model.api_model,
        "messages": messages,
        "stream": stream,
    });

    let resp = client
        .post(&url)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(&format!("NETWORK_ERROR:{}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(map_http_error(status.as_u16(), &text));
    }

    if !stream {
        let json: serde_json::Value = resp.json().await.map_err(|e| redact(&format!("解析响应失败: {}", e)))?;
        let text = extract_text(&json);
        let usage = json["usage"].as_object().map(|u| ChatUsage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
            total_tokens: u["total_tokens"].as_u64().unwrap_or(0) as u32,
        });
        return Ok(ChatResult { text, model: model.api_model.clone(), usage });
    }

    // SSE 流式：逐行解析 "data: {...}"
    let mut full = String::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| redact(&format!("NETWORK_ERROR:{}", e)))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // 按行切分处理 SSE（\n\n 分隔事件）
        let mut lines = Vec::new();
        for line in buf.split_inclusive('\n') {
            lines.push(line.to_string());
        }
        buf.clear();
        for line in lines {
            if line.ends_with('\n') {
                let trimmed = line.trim();
                if let Some(data) = trimmed.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        break;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                            full.push_str(delta);
                            let _ = app.emit(AI_CHUNK_EVENT, &delta);
                        }
                    }
                }
            } else {
                buf.push_str(&line);
            }
        }
    }

    Ok(ChatResult { text: full, model: model.api_model.clone(), usage: None })
}

/// HTTP 状态 → 文档错误码（工程补充文档 §3.1）
pub(crate) fn map_http_error(status: u16, body: &str) -> String {
    let detail = redact(body);
    let err = match status {
        401 | 403 => "AUTH_INVALID",
        429 => "RATE_LIMIT",
        402 => "BALANCE_INSUFFICIENT",
        400 => "BAD_REQUEST",
        503 => "SERVICE_UNAVAILABLE",
        504 => "TIMEOUT",
        _ => "API_ERROR",
    };
    format!("{}:{}", err, detail)
}

/// 从 API 响应体中提取 chat 文本（兼容 content 为 string 或分段数组）。
/// pub(crate) 供 translate 模块复用。
pub(crate) fn extract_text(data: &serde_json::Value) -> String {
    let content = &data["choices"][0]["message"]["content"];
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

// ========== 对外命令 ==========

/// 获取模型列表 + 配置状态（不含 Key）
#[tauri::command]
pub fn get_ai_config(app: AppHandle) -> Result<AiConfig, String> {
    let settings = read_settings(&app);
    let keys = {
        let mut v = Vec::new();
        for provider in ["deepseek", "kimi", "kimi-code"] {
            let configured = keychain_get(provider).map(|k| k.is_some()).unwrap_or(false);
            v.push(ProviderKeyStatus { provider: provider.into(), configured });
        }
        v
    };
    Ok(AiConfig {
        models: default_models(),
        default_model: settings.default_model,
        keys,
    })
}

/// 保存默认模型选择（settings.json，不含 key）
#[tauri::command]
pub fn save_ai_config(app: AppHandle, default_model: String) -> Result<(), String> {
    let mut settings = read_settings(&app);
    settings.default_model = default_model;
    write_settings(&app, &settings)
}

/// 保存 API Key 到系统凭据管理器
#[tauri::command]
pub fn save_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    if !key.starts_with("sk-") && !key.contains('.') && !key.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("API Key 格式异常".into());
    }
    keychain_set(&provider, key)
}

/// 删除 API Key
#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    keychain_remove(&provider)
}

/// 测试连接：GET /models 验证 Key 是否有效；
/// 服务不支持 /models 时（如 Kimi Code）退化最小 chat 请求验证。
#[tauri::command]
pub async fn test_connection(provider: String) -> Result<String, String> {
    let key = keychain_get(&provider)?
        .ok_or_else(|| format!("KEY_NOT_SET:{}", provider))?;

    let base_url = match provider.as_str() {
        "deepseek" => "https://api.deepseek.com",
        "kimi" => "https://api.moonshot.cn/v1",
        "kimi-code" => "https://api.kimi.com/coding/v1",
        _ => return Err(format!("未知 provider: {}", provider)),
    };

    let client = reqwest::Client::new();

    // 1. 先试标准 GET /models
    let resp = client
        .get(format!("{}/models", base_url))
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|e| redact(&format!("NETWORK_ERROR:{}", e)))?;
    let status = resp.status();
    if status.is_success() {
        return Ok("连接成功，API Key 有效".into());
    }

    // 2. 端点不支持（404/405/501）→ 退化最小 chat 请求（max_tokens=1，几乎零成本）
    let not_supported = status == 404 || status == 405 || status == 501;
    if not_supported {
        let model = default_models()
            .into_iter()
            .find(|m| m.provider == provider)
            .map(|m| m.api_model)
            .unwrap_or_else(|| "kimi-for-coding".to_string());
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 1,
        });
        let resp2 = client
            .post(format!("{}/chat/completions", base_url))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(|e| redact(&format!("NETWORK_ERROR:{}", e)))?;
        let status2 = resp2.status();
        if status2.is_success() {
            return Ok("连接成功，API Key 有效".into());
        }
        let text = resp2.text().await.unwrap_or_default();
        return Err(map_http_error(status2.as_u16(), &text));
    }

    let text = resp.text().await.unwrap_or_default();
    Err(map_http_error(status.as_u16(), &text))
}

// 保持 Mutex import 占位避免警告（后续并发翻译会用到）
#[allow(dead_code)]
type _Guard = Mutex<()>;
