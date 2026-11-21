// Fonts are bundled with the app (not loaded from Google), so the demo looks the same with no internet.
import "@fontsource-variable/inter-tight";
import "./styles.css";

import { App as AntApp, ConfigProvider } from "antd";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { theme } from "./theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider theme={theme}>
      {/* AntApp gives components themed toasts and modals (App.useApp) */}
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
