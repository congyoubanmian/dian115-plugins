import { useEffect, useState } from "react";
import { resolveCoverSrc } from "./api";

/**
 * 把封面地址（裸地址或 hgcover: 标记）解析成可渲染的 blob URL。
 * 供 `<img>` / `<video poster>` 直接使用；解析完成前返回 null。
 */
export function useResolvedCover(src?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!src) return;
    resolveCoverSrc(src)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { /* 解析失败时保持空，调用方按无图处理 */ });
    return () => { alive = false; };
  }, [src]);
  return url;
}

/**
 * 图文正文 / 封面的统一错误捕获：任何 src 以 hgcover: 开头的 <img> 加载失败时，
 * 在这里解析成 blob 后回填。挂到包含危险 HTML 的容器上（onErrorCapture）。
 */
export function handleCoverErrorCapture(e: React.SyntheticEvent<HTMLElement, Event>): void {
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  if (!img) return;
  const raw = img.getAttribute("src") || "";
  if (!raw.startsWith("hgcover:")) return;
  e.preventDefault();
  e.stopPropagation();
  resolveCoverSrc(raw)
    .then((u) => { if (img.isConnected) img.src = u; })
    .catch(() => {
      /* 解析失败：移除占位，避免永久加载态 */
      if (img.isConnected) img.remove();
    });
}