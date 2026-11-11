import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider, DEFAULTS } from "./store";
import { installPlugin } from "./plugin/ctx";
import { createPreviewCtx } from "./plugin/preview";
import { loadPersist } from "./plugin/storage";
import "./index.css";
import { installPlaybackPageEvents } from "./playbackDiagnostics";

/* 无宿主预览入口：用 dev proxy 桥接上游，跑通页面与接口链路。 */

installPlaybackPageEvents();

async function main() {
  const preview = createPreviewCtx();
  installPlugin(preview);
  const initialTheme = preview.theme.mode;
  const persist = await loadPersist(DEFAULTS);

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppProvider initialPersist={persist} initialTheme={initialTheme}>
        <App />
      </AppProvider>
    </React.StrictMode>,
  );
}

void main();