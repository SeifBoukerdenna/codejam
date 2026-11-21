import type { ThemeConfig } from "antd";

// Ant Design restyled to match styles.css: black primary, soft greys, no shadows, rounded everything.
// Change a colour here and in styles.css' :root together.
export const theme: ThemeConfig = {
  token: {
    fontFamily: '"Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 15,
    colorPrimary: "#111111",
    colorInfo: "#1f63b5",
    colorSuccess: "#0f7b3d",
    colorWarning: "#8f5400",
    colorError: "#c0302f",
    colorText: "#111111",
    colorTextSecondary: "#52514e",
    colorBorder: "#e3e3e0",
    colorBorderSecondary: "#ececea",
    colorBgLayout: "#ffffff",
    borderRadius: 12,
    controlHeight: 40,
    boxShadowSecondary: "0 6px 20px rgba(0, 0, 0, 0.08)",
  },
  components: {
    Button: { primaryShadow: "none", defaultShadow: "none", fontWeight: 600 },
    Segmented: { trackBg: "#f2f2f0", itemSelectedBg: "#ffffff" },
    Input: { activeShadow: "none" },
    Select: { optionSelectedBg: "#f2f2f0" },
  },
};
