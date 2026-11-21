import type { ThemeConfig } from "antd";

// Ant Design restyled to match the tokens in styles.css. Ant reads plain values, not CSS variables, so the
// numbers are repeated here: change one, change both.
export const theme: ThemeConfig = {
  token: {
    fontFamily: '"Inter Tight Variable", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 15,
    colorPrimary: "#111111",
    colorInfo: "#1d5fb3",
    colorSuccess: "#0b7a43",
    colorWarning: "#8a5300",
    colorError: "#b42318",
    colorText: "#111111",
    colorTextSecondary: "#5f5f5a",
    colorTextPlaceholder: "#6b6b66",     // --ink-3: still readable (AA) on the grey input background
    colorBorder: "#e4e4e1",
    colorBorderSecondary: "#e6e6e3",
    colorBgLayout: "#ffffff",
    colorBgContainer: "#ffffff",
    borderRadius: 12,                    // --radius-md
    borderRadiusLG: 20,                  // --radius-xl
    borderRadiusSM: 8,                   // --radius-sm
    controlHeight: 44,
    controlHeightLG: 50,
    boxShadowSecondary: "0 12px 40px rgba(0, 0, 0, 0.12)",   // --shadow, the only one
    motionDurationFast: "0.12s",         // --dur-fast
    motionDurationMid: "0.16s",          // --dur
    motionDurationSlow: "0.2s",          // --dur-slow
    motionEaseOut: "cubic-bezier(0.2, 0, 0, 1)",
  },
  components: {
    Button: { primaryShadow: "none", defaultShadow: "none", fontWeight: 650, contentFontSizeLG: 16 },
    Input: { activeShadow: "none", colorBgContainer: "#f6f6f4", colorBorder: "transparent", hoverBorderColor: "#d9d9d5" },
    Select: { optionSelectedBg: "#f6f6f4", optionActiveBg: "#f6f6f4" },
    Modal: { borderRadiusLG: 24 },
    Drawer: { colorBgElevated: "#ffffff" },
    Message: { contentBg: "#111111", colorText: "#ffffff" },
    Tooltip: { colorBgSpotlight: "#111111", borderRadius: 12 },
  },
};
