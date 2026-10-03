import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Document, isMap, isScalar, parseDocument, YAMLMap } from "yaml";
import {
  loadWorkspace,
  ORG_FILES,
  ORG_NAME,
  type OrgPart,
  partOfKey,
} from "../config/workspace.ts";
import { CodeflowError } from "../errors.ts";
import { Store } from "../store/store.ts";
import { orgNameFrom } from "./init.ts";

export type MigrateOptions = { config: string; org?: string };

/**
 * Turns a single-file config into a workspace with one org: the config's keys split across the
 * org's files, comments kept, and its database moved to the org's data folder. The old file is
 * kept beside the new one, as <name>.single.bak.
 */
export async function migrate(options: MigrateOptions): Promise<void> {
  const workspace = await loadWorkspace(options.config);
  if (!workspace.single) throw new CodeflowError(`${options.config} is already a workspace.`);
  const [single] = workspace.orgs;
  if (!single) throw new CodeflowError(`${options.config} holds no org.`);
  const first = single.config.sources[0];
  const name = options.org ?? orgNameFrom(first?.owner ?? "default");
  if (!ORG_NAME.test(name)) {
    throw new CodeflowError(`"${name}" can't name an org: use lowercase letters, digits, - and _.`);
  }

  const path = resolve(options.config);
  const root = dirname(path);
  const dir = join(root, "orgs", name);
  if (existsSync(dir)) throw new CodeflowError(`${dir} already exists: choose another --org.`);
  const dataFrom = dirname(single.dbPath);
  const dataTo = join(root, ".codeflow", name);
  if (existsSync(single.dbPath)) {
    const store = Store.open(single.dbPath);
    const busy = store.lockHolder("sync");
    store.close();
    if (busy) throw new CodeflowError("A sync is running. Run migrate once it has finished.");
  }

  // Split the file's top-level keys, with the comments around them, into the org's files.
  const source = parseDocument(await readFile(path, "utf8"));
  const parts = new Map<OrgPart, Document>();
  const docFor = (part: OrgPart) => {
    let doc = parts.get(part);
    if (!doc) {
      doc = new Document();
      doc.contents = new YAMLMap();
      parts.set(part, doc);
    }
    return doc;
  };
  docFor("org").commentBefore = source.commentBefore;
  if (isMap(source.contents)) {
    for (const pair of source.contents.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (key === "data_dir") continue; // the data moves to the workspace's place for it
      (docFor(partOfKey(key)).contents as YAMLMap).items.push(pair);
    }
  }

  await mkdir(dir, { recursive: true });
  for (const [part, doc] of parts) await writeFile(join(dir, ORG_FILES[part]), doc.toString());
  await copyFile(path, `${path}.single.bak`);
  await writeFile(
    path,
    `# codeflow workspace: the orgs it measures. Each org lives in orgs/<name>/.\n\norgs:\n  ${name}: {}\n`,
  );

  const moved: string[] = [];
  if (existsSync(single.dbPath) && resolve(dataFrom) !== resolve(dataTo)) {
    await mkdir(dataTo, { recursive: true });
    for (const file of ["codeflow.db", "codeflow.db-wal", "codeflow.db-shm", "report-data.json"]) {
      if (existsSync(join(dataFrom, file))) {
        await rename(join(dataFrom, file), join(dataTo, file));
        moved.push(file);
      }
    }
  }
  const shown = (p: string) => relative(process.cwd(), p) || p;
  console.log(
    `Org "${name}": ${[...parts.keys()].map((p) => shown(join(dir, ORG_FILES[p]))).join(", ")}`,
  );
  if (moved.length > 0) console.log(`Data: moved to ${shown(dataTo)}`);
  console.log(`The old config is kept as ${shown(`${path}.single.bak`)}.`);
}
