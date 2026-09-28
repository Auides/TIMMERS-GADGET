import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TIMMERS GADGET",
    short_name: "TIMMERS GADGET",
    description: "TIMMERS GADGET retail operations.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#f6f7f8",
    theme_color: "#102a43",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
