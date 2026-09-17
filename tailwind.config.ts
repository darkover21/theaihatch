import path from "node:path";
import type { Config } from "tailwindcss";

export default {
  content: [path.resolve("apps/web/index.html"), path.resolve("apps/web/src/**/*.{ts,tsx}")],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
