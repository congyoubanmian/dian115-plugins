import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider, DEFAULTS } from "./store";
import { installPlugin, loadLine, loadSession, setHostThemeListener, type DianPluginCtx } from "./plugin/ctx";
import { loadPersist } from "./plugin/storage";
import { initPlaybackLog, installPlaybackPageEvents } from "./playbackDiagnostics";
import styles from "./index.css?inline";

declare const __APP_VERSION__: string;

installPlaybackPageEvents();

/**
 * DIAN115 v3 页面入口：宿主 import 本模块并调用 mount(el, ctx)。
 * 返回清理函数；异步初始化（KV 恢复线路/会话/持久层）在首屏渲染前完成。
 */
export async function mount(element: HTMLElement, ctx: DianPluginCtx): Promise<() => void> {
  installPlugin(ctx);

  if (!document.getElementById("hghub-plugin-css")) {
    const style = document.createElement("style");
    style.id = "hghub-plugin-css";
    style.textContent = styles;
    document.head.appendChild(style);
  }

  // 主题跟随：初始取宿主主题；宿主切换时同步（除非用户在设置里手动改过）
  const initialTheme: "light" | "dark" = ctx.theme?.mode === "light" ? "light" : "dark";

  const [persist, session, line] = await Promise.all([
    loadPersist(DEFAULTS),
    loadSession().catch(() => ({})),
    loadLine(),
  ]);
  void session;
  void line;
  void initPlaybackLog();

  const root = createRoot(element);
  root.render(
    <React.StrictMode>
      <AppProvider initialPersist={persist} initialTheme={initialTheme}>
        <App />
      </AppProvider>
    </React.StrictMode>,
  );

  setHostThemeListener((mode) => {
    // 通过自定义事件通知 store 更新主题（避免在模块层直接操作 React 状态）
    document.dispatchEvent(new CustomEvent("hghub:host-theme", { detail: mode }));
  });

  const onUnload = () => {
    root.unmount();
  };
  return onUnload;
}