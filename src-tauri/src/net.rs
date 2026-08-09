//! 共享 HTTP 客户端（代码审查 P1：全局复用 + 超时）
//!
//! 此前 ai/translate 每次调用都 `reqwest::Client::new()` 且无超时：
//! - 每次新建会重复建立连接池/TLS 会话，浪费资源
//! - 无超时 → 服务端挂起时前端无限等待
//!
//! 现在分两类全局单例：
//! - `ai_client()`：AI API 调用（chat/test_connection），10s 连接 + 300s 总超时
//! - `download_client()`：大文件下载（环境组件安装），30s 连接 + 600s 总超时

use std::sync::OnceLock;
use std::time::Duration;

/// AI API 调用客户端：连接 10s + 总超时 300s（LLM 长输出足够）
pub(crate) fn ai_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .build()
            .expect("构建 AI HTTP Client 失败")
    })
}

/// 大文件下载客户端：连接 30s + 总超时 600s（JRE 186MB 下载）
pub(crate) fn download_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600))
            .build()
            .expect("构建下载 HTTP Client 失败")
    })
}
