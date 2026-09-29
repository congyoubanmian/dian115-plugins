//! 海报层纯函数的集成测试: MIME 嗅探与上限常量。
//!
//! `get-poster` 的完整行为(缓存、镜像回退、`s_ratio` → `m_ratio` 降级、重试间隔)需要
//! 宿主替身, 用例在 `src/poster.rs` 的 `mod tests` 里 —— 那里才能装
//! `host::testhost` 的同线程替身, 走真实的 host.call 编码/解析路径。

use plugin::poster::{sniff_image, IMAGE_ACCEPT, MAX_POSTER_BYTES, POSTER_CACHE_LIMIT};

/// Go `main.go:2181` `sniffImage`: 只认四种格式, 其余空串。
#[test]
fn sniff_image_recognizes_only_the_four_poster_formats() {
    // JPEG: FF D8 FF
    assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF]), "image/jpeg");
    assert_eq!(
        sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]),
        "image/jpeg"
    );
    // PNG: 第 2~4 字节 PNG(Go 不校验首字节 0x89)
    assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n"), "image/png");
    assert_eq!(sniff_image(b"\x00PNG\r\n\x1a\n"), "image/png");
    // GIF: GIF
    assert_eq!(sniff_image(b"GIF87a"), "image/gif");
    assert_eq!(sniff_image(b"GIF89a"), "image/gif");
    // WebP: RIFF....WEBP, 至少 12 字节
    let mut webp = b"RIFF".to_vec();
    webp.extend_from_slice(&[0x24, 0x00, 0x00, 0x00]);
    webp.extend_from_slice(b"WEBPVP8 ");
    assert_eq!(sniff_image(&webp), "image/webp");

    // 非图片 / 太短 / RIFF 但不是 WEBP
    assert_eq!(sniff_image(b""), "");
    assert_eq!(sniff_image(b"<html>418 I'm a teapot</html>"), "");
    assert_eq!(sniff_image(b"{\"pic\":{\"normal\":\"x\"}}"), "");
    assert_eq!(sniff_image(b"GI"), "", "长度不足 3");
    assert_eq!(sniff_image(b"GIF"), "image/gif");
    assert_eq!(sniff_image(b"RIFF"), "");
    assert_eq!(sniff_image(b"RIFF????WEB"), "", "长度不足 12");
    assert_eq!(sniff_image(b"RIFF????AVI "), "");
    assert_eq!(sniff_image(&[0xFF, 0xD8]), "");
}

/// Go `main.go:28`/`main.go:30`/`main.go:1860` 的三个常量。
#[test]
fn poster_limits_match_go() {
    assert_eq!(POSTER_CACHE_LIMIT, 64);
    assert_eq!(MAX_POSTER_BYTES, 128 * 1024);
    assert_eq!(IMAGE_ACCEPT, "image/avif,image/webp,image/jpeg,image/*;q=0.8");
}
