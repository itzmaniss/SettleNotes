import type { NextConfig } from "next";

// Self-hosted container builds set NEXT_OUTPUT=standalone (see the Dockerfile)
// so `next build` also emits .next/standalone with a traced node_modules tree.
// Vercel and `bun run dev` leave it unset and behave exactly as before.
const standalone = process.env.NEXT_OUTPUT === "standalone";

const nextConfig: NextConfig = {
  // Both packages resolve files at runtime by path, so they must stay out of
  // the server bundle: sharp loads platform native binaries dynamically and
  // ffmpeg-static points at a downloaded binary next to its index.js. The
  // standalone trace cannot see those runtime resolutions, so the files are
  // also listed in outputFileTracingIncludes below.
  serverExternalPackages: ["sharp", "ffmpeg-static"],
};

if (standalone) {
  nextConfig.output = "standalone";
  // "/**" applies to every server route. Copy the ffmpeg binary, sharp's
  // native module and the libvips binaries sharp loads into the trace.
  nextConfig.outputFileTracingIncludes = {
    "/**": [
      "./node_modules/ffmpeg-static/**",
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
    ],
  };
}

export default nextConfig;
