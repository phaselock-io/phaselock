import { theme as antdTheme, type ThemeConfig } from 'antd';

/** PhaseLock's colors, as phaselock.io uses them: a near-neutral dark ground and text, and
    phosphor green as the one accent.  The page is darker than the site's, so the cards stand a
    clear step above it. */
export const PALETTE = {
  ground: '#0b0f0d',
  panel: '#18221e',
  border: '#2c3a33',
  rule: '#26322c',
  text: '#e8ece9',
  muted: '#8a9a92',
  accent: '#2ee6a8',
  accentDim: '#24c791',
  onAccent: '#0a1f18',
  amber: '#f2d98c',
  alarm: '#e5786d',
};

/** a color mixed toward black, keeping the fraction of it given: a dark shade of its hue */
export function shade(color: string, amount = 0.12): string {
  const rgb = parseInt(color.slice(1), 16);
  const channel = (shift: number) =>
    Math.round(((rgb >> shift) & 0xff) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** antd's dark theme in PhaseLock's colors */
export const theme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: PALETTE.accent,
    colorLink: PALETTE.accent,
    // the text on a primary button, dark on the bright green
    colorTextLightSolid: PALETTE.onAccent,
    colorBgBase: PALETTE.ground,
    colorBgContainer: PALETTE.panel,
    colorBgElevated: PALETTE.panel,
    colorBorder: PALETTE.border,
    colorBorderSecondary: PALETTE.rule,
    colorText: PALETTE.text,
    fontFamily: 'system-ui, Helvetica, Arial, sans-serif',
  },
  components: {
    /* A primary button is the one call to action, solid green with dark text; every other button
       looks as the badges do, its color's text and border over a dark shade of it, and turns
       green under the pointer.  A disabled button is gray throughout, so it never reads as one
       under the pointer. */
    Button: {
      colorPrimary: PALETTE.accentDim,
      colorPrimaryHover: PALETTE.accent,
      colorPrimaryActive: '#1fae7e',
      primaryColor: PALETTE.onAccent,
      defaultBg: shade(PALETTE.text, 0.06),
      defaultColor: PALETTE.text,
      defaultBorderColor: PALETTE.border,
      defaultHoverBg: shade(PALETTE.accent),
      defaultHoverColor: PALETTE.accent,
      defaultHoverBorderColor: PALETTE.accent,
      defaultActiveBg: shade(PALETTE.accent, 0.08),
      defaultActiveColor: PALETTE.accent,
      defaultActiveBorderColor: PALETTE.accent,
      defaultBgDisabled: shade(PALETTE.text, 0.06),
      borderColorDisabled: '#2a2a2a',
      colorTextDisabled: '#5c5c5c',
    },
  },
};

/** the color of each state of an Engine's connection */
export const STATE_COLORS = {
  connecting: PALETTE.amber,
  syncing: PALETTE.accentDim,
  live: PALETTE.accent,
  offline: PALETTE.alarm,
};

/** a tag's style in a color: its text and border in the color, over a dark shade of it */
export function tinted(color: string) {
  return { color, borderColor: color, background: shade(color) };
}
