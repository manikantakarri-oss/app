/** Static export: Databricks Apps runs a single command (uvicorn), so there is
 *  no Node server to host Next. Exporting to plain files lets the existing
 *  FastAPI app serve the UI with no backend changes beyond where it looks.
 *
 *  Two apps share this project, its components and its styles:
 *  - `npm run build`          the Agent Portal  (app/page.tsx, app/layout.tsx -> out/)
 *  - `npm run build:deployer` the Portal Deployer (app/page.deployer.tsx,
 *    app/layout.deployer.tsx -> out-deployer/). Only files ending
 *    `.deployer.tsx` count as its pages, and the portal ignores them (their
 *    names are not `page`/`layout`), so neither build ships the other. */
const deployer = (process.env.npm_lifecycle_event || "").endsWith(":deployer") || process.env.APP_TARGET === "deployer";

const nextConfig = {
  output: "export",
  distDir: deployer ? "out-deployer" : "out",
  // Two entries on purpose: with a single one, Next 14 passes a string to its
  // app loader and fails with "pageExtensions.map is not a function".
  pageExtensions: deployer ? ["deployer.tsx", "deployer.ts"] : ["tsx", "ts", "jsx", "js"],
  images: { unoptimized: true },
  trailingSlash: false,
};
export default nextConfig;
