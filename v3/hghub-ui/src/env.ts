/**
 * 运行环境常量：插件模式 vs 桌面（Tauri）。独立成模块避免 api/html 循环依赖。
 */

/** 插件模式：页面运行在 DIAN115 宿主内，走 ctx 桥接（无 Tauri / 本地协议）。 */
export const PLUGIN = __PLUGIN_MODE__;

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
/** iPhone 的 UA 也带「like Mac OS X」，必须先于 macOS 判断；iPadOS 默认伪装成 Mac，用触点数区分。 */
export const isIos = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);

/** 插件模式按移动端布局渲染（宿主内容区就是一块可滚动面板，底栏由应用自己画）。 */
export const platform: "android" | "ios" | "windows" | "macos" =
  PLUGIN ? "android" : isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : "windows";
/** 移动端（安卓 / iOS）共用触屏界面 */
export const isMobile = PLUGIN || isAndroid || isIos;

/** 仅桌面客户端使用（Tauri 本地协议）；插件模式无本地协议。 */
export const LOCAL = isMacos || isIos ? "hg://localhost" : "http://hg.localhost";
export const isLocalMedia = (src: string) => !PLUGIN && src.startsWith(`${LOCAL}/`);