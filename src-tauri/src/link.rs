//! 链接卡片：获取网页的标题、简介、预览图和网站图标，以及用浏览器打开链接。
//!
//! 只在用户把链接放到画布上（或手动刷新预览）时访问该网页。预览图和图标下载到
//! 工作区的 .lattira/links/ 下，之后离线也能显示。

use std::path::Path;
use std::time::Duration;

use reqwest::{header, Client, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};
use crate::files;
use crate::workspace::AppState;

/// 网页只读前 1 MB：标题和 meta 标签都在开头
const PAGE_LIMIT: usize = 1 << 20;
const IMAGE_LIMIT: usize = 5 << 20;
const TIMEOUT: Duration = Duration::from_secs(10);
const LINKS_DIR: &str = ".lattira/links";
/// 部分网站只给浏览器返回完整的 meta 信息
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Lattira";

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    title: Option<String>,
    description: Option<String>,
    site_name: Option<String>,
    /// 预览图，相对工作区根目录的路径
    image: Option<String>,
    /// 网站图标，相对工作区根目录的路径
    icon: Option<String>,
}

fn parse_web_url(url: &str) -> Result<Url> {
    let parsed = Url::parse(url.trim()).map_err(|_| Error::Invalid(format!("不是有效的网址：{url}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::Invalid(format!("只支持 http 和 https 链接：{url}")));
    }
    Ok(parsed)
}

fn net_err(e: reqwest::Error) -> Error {
    Error::Invalid(format!("无法访问网页：{e}"))
}

fn client() -> Result<Client> {
    // 与在线更新共用 ring 加密实现；已经装好时这里什么也不做
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .build()
        .map_err(net_err)
}

/// 读取响应体，最多 limit 字节
async fn read_limited(mut resp: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net_err)? {
        let room = limit - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= limit {
            break;
        }
    }
    Ok(body)
}

fn content_type(resp: &reqwest::Response) -> String {
    resp.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// 访问网页，提取标题、简介、预览图和图标；图片下载到工作区
#[tauri::command]
pub async fn fetch_link_preview(state: State<'_, AppState>, url: String) -> Result<LinkPreview> {
    let root = state.with(|ws| Ok(ws.root.clone()))?;
    fetch_preview(&root, &url).await
}

async fn fetch_preview(root: &Path, url: &str) -> Result<LinkPreview> {
    let url = parse_web_url(url)?;
    let client = client()?;
    let resp = client.get(url.clone()).send().await.map_err(net_err)?;
    if !resp.status().is_success() {
        return Err(Error::Invalid(format!("网页返回了错误：{}", resp.status())));
    }
    let base = resp.url().clone();
    let ctype = content_type(&resp);

    // 链接本身是图片：直接作为预览图
    if ctype.starts_with("image/") {
        let bytes = read_limited(resp, IMAGE_LIMIT).await?;
        return Ok(LinkPreview {
            title: file_name(&base),
            image: save_image(root, &base, &ctype, &bytes),
            ..Default::default()
        });
    }
    // PDF 等其他文件：用文件名作标题
    if !ctype.is_empty() && !ctype.contains("html") {
        return Ok(LinkPreview { title: file_name(&base), ..Default::default() });
    }

    let bytes = read_limited(resp, PAGE_LIMIT).await?;
    let html = decode_html(&bytes, &ctype);
    let meta = parse_html(&html);

    let image = match meta.image.as_deref().and_then(|s| base.join(s).ok()) {
        Some(u) => download_image(&client, root, &u).await,
        None => None,
    };
    let mut icon = None;
    let fallback_icon = base.join("/favicon.ico").ok();
    for u in meta.icons.iter().filter_map(|s| base.join(s).ok()).chain(fallback_icon) {
        icon = download_image(&client, root, &u).await;
        if icon.is_some() {
            break;
        }
    }
    Ok(LinkPreview {
        title: meta.title.or_else(|| file_name(&base)),
        description: meta.description,
        site_name: meta.site_name,
        image,
        icon,
    })
}

/// 用默认浏览器打开链接
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<()> {
    let url = parse_web_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| Error::Invalid(format!("无法打开链接：{e}")))
}

/// 网址最后一段（解码后），用作非网页链接的标题
fn file_name(url: &Url) -> Option<String> {
    let last = url.path_segments()?.rev().find(|s| !s.is_empty())?;
    let decoded = percent_decode(last);
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// 图片缓存
// ---------------------------------------------------------------------------

async fn download_image(client: &Client, root: &Path, url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let resp = client.get(url.clone()).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let ctype = content_type(&resp);
    if !ctype.starts_with("image/") {
        return None;
    }
    let bytes = read_limited(resp, IMAGE_LIMIT).await.ok()?;
    save_image(root, url, &ctype, &bytes)
}

/// 按网址命名保存到 .lattira/links/，返回相对工作区的路径；同一张图只存一份
fn save_image(root: &Path, url: &Url, ctype: &str, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() >= IMAGE_LIMIT {
        return None;
    }
    let ext = match ctype.split(';').next().unwrap_or_default().trim() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        _ => return None,
    };
    let hash: String = Sha256::digest(url.as_str().as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
    let rel = format!("{LINKS_DIR}/{hash}.{ext}");
    let abs = files::resolve(root, &rel);
    if !abs.is_file() {
        std::fs::create_dir_all(abs.parent()?).ok()?;
        files::write_atomic(&abs, bytes).ok()?;
    }
    Some(rel)
}

// ---------------------------------------------------------------------------
// HTML 解析：只需要 <title>、<meta> 和 <link rel="icon">，不必完整解析
// ---------------------------------------------------------------------------

#[derive(Default, Debug)]
struct PageMeta {
    title: Option<String>,
    description: Option<String>,
    site_name: Option<String>,
    image: Option<String>,
    /// 按优先级排列的图标地址
    icons: Vec<String>,
}

/// 按 Content-Type 或 <meta charset> 声明的编码解码，默认 UTF-8（国内仍有少量 GBK 网页）
fn decode_html(bytes: &[u8], ctype: &str) -> String {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let label = charset_in(ctype).or_else(|| {
        let at = head.find("charset=")?;
        let rest = head[at + 8..].trim_start_matches(['"', '\'']);
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(rest.len());
        Some(rest[..end].to_string())
    });
    let encoding = label
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

fn charset_in(ctype: &str) -> Option<String> {
    let at = ctype.find("charset=")?;
    Some(ctype[at + 8..].trim_matches(['"', '\'', ' ', ';']).to_string())
}

fn parse_html(html: &str) -> PageMeta {
    // 只转换 ASCII 大小写，字节位置与原文一致
    let lower = html.to_ascii_lowercase();
    let mut meta = PageMeta::default();
    let mut og_title = None;
    let mut tw_title = None;
    let mut og_desc = None;
    let mut tw_desc = None;
    let mut desc = None;
    let mut og_image = None;
    let mut tw_image = None;
    let mut touch_icons = Vec::new();
    let mut icons = Vec::new();

    let mut pos = 0;
    while let Some(off) = lower[pos..].find('<') {
        let start = pos + off;
        let Some(len) = lower[start..].find('>') else { break };
        let end = start + len;
        let tag = &html[start + 1..end];
        let tag_lower = &lower[start + 1..end];
        pos = end + 1;

        if tag_lower.starts_with("meta") {
            let attrs = attributes(&tag[4..]);
            let key = attr(&attrs, "property").or_else(|| attr(&attrs, "name")).map(str::to_ascii_lowercase);
            let Some(content) = attr(&attrs, "content").map(clean) else { continue };
            if content.is_empty() {
                continue;
            }
            let slot = match key.as_deref() {
                Some("og:title") => &mut og_title,
                Some("twitter:title") => &mut tw_title,
                Some("og:description") => &mut og_desc,
                Some("twitter:description") => &mut tw_desc,
                Some("description") => &mut desc,
                Some("og:image" | "og:image:url" | "og:image:secure_url") => &mut og_image,
                Some("twitter:image" | "twitter:image:src") => &mut tw_image,
                Some("og:site_name") => &mut meta.site_name,
                _ => continue,
            };
            slot.get_or_insert(content);
        } else if tag_lower.starts_with("link") {
            let attrs = attributes(&tag[4..]);
            let rel = attr(&attrs, "rel").unwrap_or_default().to_ascii_lowercase();
            let Some(href) = attr(&attrs, "href").map(clean).filter(|h| !h.is_empty()) else { continue };
            let rels: Vec<&str> = rel.split_whitespace().collect();
            if rels.contains(&"apple-touch-icon") || rels.contains(&"apple-touch-icon-precomposed") {
                touch_icons.push(href);
            } else if rels.contains(&"icon") {
                icons.push(href);
            }
        } else if tag_lower.starts_with("title") && meta.title.is_none() {
            if let Some(close) = lower[pos..].find("</title") {
                let text = clean(&html[pos..pos + close]);
                if !text.is_empty() {
                    meta.title = Some(text);
                }
                pos += close;
            }
        } else if tag_lower.starts_with("script") || tag_lower.starts_with("style") {
            // 跳过脚本和样式的内容，里面的 < 不是标签
            let close = if tag_lower.starts_with("script") { "</script" } else { "</style" };
            match lower[pos..].find(close) {
                Some(n) => pos += n,
                None => break,
            }
        }
    }

    meta.title = og_title.or(tw_title).or(meta.title);
    meta.description = og_desc.or(tw_desc).or(desc);
    meta.image = og_image.or(tw_image);
    // 苹果触摸图标通常是 180px 的方形图，比 16px 的 favicon 清晰
    meta.icons = touch_icons.into_iter().chain(icons).collect();
    meta
}

/// 解析标签里的属性：name="value"、name='value'、name=value、单独的 name
fn attributes(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut chars = s.char_indices().peekable();
    while let Some(&(i, c)) = chars.peek() {
        if c.is_whitespace() || c == '/' {
            chars.next();
            continue;
        }
        let mut name_end = i;
        while let Some(&(j, c)) = chars.peek() {
            if c.is_whitespace() || c == '=' || c == '/' {
                break;
            }
            name_end = j + c.len_utf8();
            chars.next();
        }
        let name = s[i..name_end].to_ascii_lowercase();
        while chars.peek().is_some_and(|&(_, c)| c.is_whitespace()) {
            chars.next();
        }
        let mut value = String::new();
        if chars.peek().is_some_and(|&(_, c)| c == '=') {
            chars.next();
            while chars.peek().is_some_and(|&(_, c)| c.is_whitespace()) {
                chars.next();
            }
            match chars.peek().map(|&(_, c)| c) {
                Some(q @ ('"' | '\'')) => {
                    chars.next();
                    for (_, c) in chars.by_ref() {
                        if c == q {
                            break;
                        }
                        value.push(c);
                    }
                }
                _ => {
                    while let Some(&(_, c)) = chars.peek() {
                        if c.is_whitespace() {
                            break;
                        }
                        value.push(c);
                        chars.next();
                    }
                }
            }
        }
        if !name.is_empty() {
            out.push((name, value));
        }
    }
    out
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

/// 解码 HTML 实体并合并空白
fn clean(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest.find(';').filter(|&n| n <= 10).and_then(|semi| {
            let ent = &rest[1..semi];
            let c = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                _ => None,
            };
            c.map(|c| (c, semi + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_open_graph_and_collects_icons() {
        let html = r#"<!doctype html><html><head>
            <meta charset="utf-8">
            <title>  页面 &amp; 标题 </title>
            <meta name="description" content="普通简介">
            <meta property="og:title" content="分享标题" />
            <meta property='og:description' content='分享&quot;简介&quot;'>
            <meta property="og:image" content="/cover.jpg">
            <meta property="og:site_name" content="示例网站">
            <link rel="icon" href="/favicon-32.png">
            <link rel="apple-touch-icon" href="/touch.png">
            <script>if (a < b) document.write("<meta property='og:title' content='错的'>")</script>
            </head></html>"#;
        let meta = parse_html(html);
        assert_eq!(meta.title.as_deref(), Some("分享标题"));
        assert_eq!(meta.description.as_deref(), Some("分享\"简介\""));
        assert_eq!(meta.image.as_deref(), Some("/cover.jpg"));
        assert_eq!(meta.site_name.as_deref(), Some("示例网站"));
        assert_eq!(meta.icons, vec!["/touch.png", "/favicon-32.png"]);
    }

    #[test]
    fn falls_back_to_title_tag() {
        let meta = parse_html("<html><head><TITLE>Hello&#x20;World&#33;</TITLE></head><body><p>x</p></body></html>");
        assert_eq!(meta.title.as_deref(), Some("Hello World!"));
        assert_eq!(meta.description, None);
        assert!(meta.icons.is_empty());
    }

    #[test]
    fn unquoted_attributes() {
        let attrs = attributes(r#" name=description content="a b" data-x=1 hidden/"#);
        assert_eq!(attr(&attrs, "name"), Some("description"));
        assert_eq!(attr(&attrs, "content"), Some("a b"));
        assert_eq!(attr(&attrs, "data-x"), Some("1"));
        assert_eq!(attr(&attrs, "hidden"), Some(""));
    }

    #[test]
    fn decodes_gbk_pages() {
        let (bytes, _, _) = encoding_rs::GBK.encode("<meta charset=\"gbk\"><title>中文标题</title>");
        let html = decode_html(&bytes, "text/html");
        assert_eq!(parse_html(&html).title.as_deref(), Some("中文标题"));
        let html = decode_html(&bytes, "text/html; charset=GBK");
        assert_eq!(parse_html(&html).title.as_deref(), Some("中文标题"));
    }

    #[test]
    fn file_name_from_url() {
        let u = Url::parse("https://example.com/docs/%E6%8A%A5%E5%91%8A.pdf?x=1").unwrap();
        assert_eq!(file_name(&u).as_deref(), Some("报告.pdf"));
        assert_eq!(file_name(&Url::parse("https://example.com/").unwrap()), None);
    }

    /// 需要联网：cargo test fetch_real_page -- --ignored --nocapture
    /// 设置 LATTIRA_LINK_URL 可以换成别的网页，打印获取结果
    #[test]
    #[ignore]
    fn fetch_real_page() {
        let root = std::env::temp_dir().join("lattira-link-test");
        let custom = std::env::var("LATTIRA_LINK_URL").ok();
        let url = custom.as_deref().unwrap_or("https://example.com/");
        let preview = tauri::async_runtime::block_on(fetch_preview(&root, url)).expect("获取失败");
        println!("{preview:#?}");
        for rel in [&preview.image, &preview.icon].into_iter().flatten() {
            assert!(files::resolve(&root, rel).is_file(), "{rel} 没有保存下来");
        }
        if custom.is_none() {
            assert_eq!(preview.title.as_deref(), Some("Example Domain"));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_non_web_urls() {
        assert!(parse_web_url("file:///C:/Windows").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
        assert!(parse_web_url(" https://example.com ").is_ok());
    }
}
