// Builds the report page: src/report → dist/report/index.html, one file with its script and
// styles inline, so a report opens from disk with no server. `codeflow build` fills in the data.
//
//   npm run build:report   build the page
//   npm run report:dev     live-reloading page with data from .codeflow/report-data.json
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Moves the built script and stylesheet into index.html itself. */
function inlineAssets(): Plugin {
  return {
    name: "codeflow:inline-assets",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return;
      let html = String(page.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === "chunk") {
          const code = file.code.replaceAll("</script", "<\\/script");
          html = html.replace(
            new RegExp(`<script[^>]*src="[^"]*${escapeRegExp(file.fileName)}"[^>]*></script>`),
            () => `<script type="module">${code}</script>`,
          );
          delete bundle[name];
        } else if (file.fileName.endsWith(".css")) {
          html = html.replace(
            new RegExp(`<link[^>]*href="[^"]*${escapeRegExp(file.fileName)}"[^>]*>`),
            () => `<style>${String(file.source)}</style>`,
          );
          delete bundle[name];
        }
      }
      page.source = html;
    },
  };
}

/** Serves the data `codeflow build --data-only` wrote, for the development server. */
function devData(): Plugin {
  const file = here(".codeflow/report-data.json");
  return {
    name: "codeflow:dev-data",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/codeflow-data.json", (_req, res) => {
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end("No report data. Run: npm run codeflow -- build --data-only");
          return;
        }
        res.setHeader("content-type", "application/json");
        createReadStream(file).pipe(res);
      });
    },
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default defineConfig({
  root: here("src/report"),
  base: "./",
  plugins: [inlineAssets(), devData()],
  build: {
    outDir: here("dist/report"),
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
});
