//! AI 服务底座（Prompt 4 前置）
//!
//! 职责：
//! 1. 模型配置（DeepSeek V4 Flash/Pro + Kimi K3，OpenAI 兼容）
//! 2. API Key 安全存储（系统凭据管理器 keyring，绝不明文落盘/进 Git）
//! 3. chat 补全 API（reqwest + SSE 流式），供翻译/聊天/AI 重排复用
//! 4. 连接测试 + 错误码映射（对齐工程补充文档 §3.1）
//!
//! 安全约定：
//! - API Key 只存 keyring（Windows Credential Manager），不出现在任何
//!   settings.json / 日志 / 错误消息中
//! - 所有错误消息先经 redact() 脱敏（sk-xxx 替换为 ***）
//! - provider 白名单校验：save_api_key / test_connection 只接受已知 provider

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub mod restructure;
pub mod translate;

// ========== 模型配置 ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    /// 应用内唯一 ID
    pub id: String,
    /// 显示名
    pub label: String,
    /// provider：deepseek | kimi | kimi-code
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

/// 模型配置唯一数据源。前端模型列表通过 get_ai_config 从此处获取，
/// 禁止在别处（含前端）再维护一份模型清单，避免漂移。
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

/// 已知 provider 列表（由模型配置推导，单一数据源）
pub(crate) fn known_providers() -> Vec<String> {
    let mut v: Vec<String> = default_models()
        .iter()
        .map(|m| m.provider.clone())
        .collect();
    v.sort();
    v.dedup();
    v
}

pub(crate) fn is_known_provider(p: &str) -> bool {
    known_providers().iter().any(|k| k == p)
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
    if !is_known_provider(provider) {
        return Err(format!("未知 provider: {}", provider));
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| format!("保存 API Key 失败: {}", e))
}

/// 读取 Key。不存在返回 Ok(None)
pub(crate) fn keychain_get(provider: &str) -> Result<Option<String>, String> {
    if !is_known_provider(provider) {
        return Err(format!("未知 provider: {}", provider));
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 API Key 失败: {}", e)),
    }
}

pub fn keychain_remove(provider: &str) -> Result<(), String> {
    if !is_known_provider(provider) {
        return Err(format!("未知 provider: {}", provider));
    }
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

/// 按 provider 取第一个模型（用于 test_connection 等按 provider 的场景）
fn model_by_provider(provider: &str) -> Option<ModelConfig> {
    default_models().into_iter().find(|m| m.provider == provider)
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

    let client = crate::net::ai_client();
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

    // SSE 流式：逐行解析 "data: {...}"。兼容 "data:xxx"（无空格）两种写法。
    let mut full = String::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut buf = String::new();
    'outer: while let Some(chunk) = stream.next().await {
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
                if let Some(data) = trimmed.strip_prefix("data:") {
                    let data = data.trim_start();
                    if data == "[DONE]" {
                        break 'outer;
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
    // 默认模型必须存在于模型列表；settings.json 可能残留旧版本已删除的模型 ID
    let default_model = if default_models().iter().any(|m| m.id == settings.default_model) {
        settings.default_model
    } else {
        "deepseek-v4-flash".to_string()
    };
    let keys = {
        let mut v = Vec::new();
        for provider in known_providers() {
            // P3-3：keychain 读取失败不再静默吞掉——记 stderr 日志（不含 Key），
            // configured 保持 false（避免误报"已配置"）
            let configured = match keychain_get(&provider) {
                Ok(k) => k.is_some(),
                Err(e) => {
                    eprintln!("[ai] keychain 读取 {} 失败: {}", provider, redact(&e));
                    false
                }
            };
            v.push(ProviderKeyStatus { provider, configured });
        }
        v
    };
    Ok(AiConfig {
        models: default_models(),
        default_model,
        keys,
    })
}

/// 保存默认模型选择（settings.json，不含 key）
#[tauri::command]
pub fn save_ai_config(app: AppHandle, default_model: String) -> Result<(), String> {
    // 校验模型 ID 合法，避免写入非法值
    if model_by_id(&default_model).is_none() {
        return Err(format!("未知模型: {}", default_model));
    }
    let mut settings = read_settings(&app);
    settings.default_model = default_model;
    write_settings(&app, &settings)
}

/// 保存 API Key 到系统凭据管理器
#[tauri::command]
pub fn save_api_key(provider: String, key: String) -> Result<(), String> {
    // provider 白名单
    if !is_known_provider(&provider) {
        return Err(format!("未知 provider: {}", provider));
    }
    let key = key.trim();
    // 宽松校验：非空、足够长、无空白/控制字符（服务商 Key 前缀可能各不相同，
    // 不做 sk- 前缀强校验，避免误拒合法 Key）
    if key.is_empty() {
        return Err("API Key 不能为空".into());
    }
    if key.len() < 8 {
        return Err("API Key 长度异常（至少 8 位）".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("API Key 不能包含空白或控制字符".into());
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
    if !is_known_provider(&provider) {
        return Err(format!("未知 provider: {}", provider));
    }
    let key = keychain_get(&provider)?
        .ok_or_else(|| format!("KEY_NOT_SET:{}", provider))?;

    // base_url 从模型配置取（单一数据源，避免硬编码漂移）
    let model = model_by_provider(&provider).ok_or_else(|| format!("未知 provider: {}", provider))?;
    let base_url = model.base_url.clone();

    let client = crate::net::ai_client();

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
        let body = serde_json::json!({
            "model": model.api_model,
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

// ========== 单元测试 ==========

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redact_masks_sk_keys() {
        assert_eq!(redact("key is sk-abc123XYZ_9"), "key is sk-***");
        assert_eq!(redact("sk-abc123"), "sk-***");
        assert_eq!(redact("no key here"), "no key here");
        // key 后紧跟非 key 字符才截断
        assert_eq!(redact("a=sk-abc123 b=1"), "a=sk-*** b=1");
    }

    #[test]
    fn test_redact_handles_trailing_key() {
        // sk- 后全是 key 字符（无分隔符）→ 全部替换
        assert_eq!(redact("Bearer sk-abcdef123456"), "Bearer sk-***");
    }

    #[test]
    fn test_map_http_error() {
        assert_eq!(map_http_error(401, "unauthorized"), "AUTH_INVALID:unauthorized");
        assert_eq!(map_http_error(403, "forbidden"), "AUTH_INVALID:forbidden");
        assert_eq!(map_http_error(429, "slow down"), "RATE_LIMIT:slow down");
        assert_eq!(map_http_error(402, "no money"), "BALANCE_INSUFFICIENT:no money");
        assert_eq!(map_http_error(400, "bad"), "BAD_REQUEST:bad");
        assert_eq!(map_http_error(503, "down"), "SERVICE_UNAVAILABLE:down");
        assert_eq!(map_http_error(504, "late"), "TIMEOUT:late");
        assert_eq!(map_http_error(500, "boom"), "API_ERROR:boom");
        // body 中的 key 必须脱敏
        assert_eq!(map_http_error(400, "invalid key sk-abc123"), "BAD_REQUEST:invalid key sk-***");
    }

    #[test]
    fn test_extract_text() {
        let v: serde_json::Value = serde_json::json!({
            "choices": [{"message": {"content": "hello"}}]
        });
        assert_eq!(extract_text(&v), "hello");

        let arr: serde_json::Value = serde_json::json!({
            "choices": [{"message": {"content": [{"text": "a"}, {"text": "b"}]}}]
        });
        assert_eq!(extract_text(&arr), "ab");
    }

    #[test]
    fn test_known_providers_single_source() {
        let providers = known_providers();
        // 与 default_models 完全一致（无重复）
        let models = default_models();
        for m in &models {
            assert!(providers.contains(&m.provider), "provider {} missing", m.provider);
        }
        assert!(is_known_provider("deepseek"));
        assert!(is_known_provider("kimi-code"));
        assert!(!is_known_provider("evil-provider"));
    }

    #[test]
    fn test_models_unique_ids() {
        let models = default_models();
        let mut ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), models.len(), "模型 ID 存在重复");
    }
}
