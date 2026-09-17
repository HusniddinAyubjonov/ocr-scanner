import type { NextConfig } from "next";

const repoName = "ocr-scanner";
const isGithubActions = process.env.GITHUB_ACTIONS === "true";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isGithubActions ? `/${repoName}` : "",
  assetPrefix: isGithubActions ? `/${repoName}/` : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
