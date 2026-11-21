import type { ThemeConfig } from "antd";

// Ant Design restyled to match styles.css. Keep the two in step.
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
    colorTextPlaceholder: "#8b8b86",
    colorBorder: "#e4e4e1",
    colorBorderSecondary: "#ebebe8",
    colorBgLayout: "#ffffff",
    colorBgContainer: "#ffffff",
    borderRadius: 12,
    borderRadiusLG: 20,
    controlHeight: 44,
    controlHeightLG: 50,
    boxShadowSecondary: "0 12px 40px rgba(0, 0, 0, 0.12)",
  },
  components: {
    Button: { primaryShadow: "none", defaultShadow: "none", fontWeight: 650, contentFontSizeLG: 16 },
    Input: { activeShadow: "none", colorBgContainer: "#f6f6f4", colorBorder: "transparent", hoverBorderColor: "#d9d9d5" },
    Select: { optionSelectedBg: "#f6f6f4", optionActiveBg: "#f6f6f4" },
    Modal: { borderRadiusLG: 24 },
    Drawer: { colorBgElevated: "#ffffff" },
    Message: { contentBg: "#111111", colorText: "#ffffff" },
  },
};
