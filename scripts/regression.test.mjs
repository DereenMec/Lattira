import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { create } from "zustand";
import { webcrypto } from "node:crypto";

function module(file, names, dependencies = {}) {
  const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const source = stripTypeScriptTypes(raw).replace(/^import\s[\s\S]*?;\s*/gm, "").replace(/^export /gm, "");
  const context = vm.createContext({ console, crypto: webcrypto, TextEncoder, ...dependencies });
  return vm.runInContext(`${source}\n;({${names.join(",")}})`, context, { filename: file });
}
const geometry = module("src/lib/geometry.ts", ["boundsOf", "contains", "center"]);
const json = module("src/lib/jsonCanvas.ts", ["fromJsonCanvas", "toJsonCanvas"], { ...geometry, FOLDER_W: 260, FOLDER_H: 76 });
const names = module("src/lib/names.ts", ["nameKey", "splitName", "uniqueName", "sanitizeName", "sanitizeFileName"]);
const node = (id, extra = {}) => ({ id, type: "text", text: "note", x: 0, y: 0, width: 260, height: 76, ...extra });
const file = (nodes, extra = {}) => JSON.stringify({ nodes, edges: [], ...extra });

test("JSON Canvas preserves custom colors, edge ends, and extension fields", () => {
  const raw = file([node("a", { color: "#102030", custom: { a: 1 }, lattira: { unknown: true } }), node("b")], {
    custom: [1, 2], lattira: { custom: true }, edges: [{ id: "e", fromNode: "a", toNode: "b", fromEnd: "arrow", toEnd: "none", fromSide: "left", color: "#123456", unknown: "kept" }],
  });
  const out = JSON.parse(json.toJsonCanvas(json.fromJsonCanvas(raw, "c"), new Map()));
  assert.equal(out.nodes[0].color, "#102030");
  assert.deepEqual(out.nodes[0].custom, { a: 1 });
  assert.equal(out.nodes[0].lattira.unknown, true);
  assert.equal(out.lattira.custom, true);
  assert.equal(out.edges[0].toEnd, "none");
  assert.equal(out.edges[0].fromSide, "left");
  assert.equal(out.edges[0].unknown, "kept");
});
test("identical legacy groups cannot hide each other in a parent cycle", () => {
  const doc = json.fromJsonCanvas(file([node("a", { type: "group" }), node("b", { type: "group" })]), "c");
  assert.ok(doc.elements.some((el) => !el.parentId));
  for (const el of doc.elements) {
    const seen = new Set(); let current = el;
    while (current?.parentId) { assert.ok(!seen.has(current.id)); seen.add(current.id); current = doc.elements.find((e) => e.id === current.parentId); }
  }
});
test("duplicate IDs, invalid content, geometry, and viewport are rejected", () => {
  for (const raw of [file([node("a"), node("a")]), file([node("a", { text: 42 })]), file([node("a", { width: -1 })]), file([], { lattira: { viewport: { x: 0, y: 0, zoom: 0 } } })]) assert.throws(() => json.fromJsonCanvas(raw, "c"));
});
test("external file nodes roundtrip without becoming text nodes", () => {
  const doc = json.fromJsonCanvas(file([node("a", { type: "file", file: "outside.pdf", text: undefined })]), "c");
  const out = JSON.parse(json.toJsonCanvas(doc, new Map()));
  assert.equal(out.nodes[0].type, "file"); assert.equal(out.nodes[0].file, "outside.pdf");
});
test("invalid extension and edge fields are rejected before rendering", () => {
  for (const extra of [{ color: 42 }, { lattira: { link: { title: 42 } } }, { lattira: { parent: [] } }]) assert.throws(() => json.fromJsonCanvas(file([node("a", extra)]), "c"));
  for (const extra of [{ label: {} }, { toEnd: "invalid" }, { fromSide: "invalid" }]) assert.throws(() => json.fromJsonCanvas(file([node("a")], { edges: [{ id: "e", fromNode: "a", toNode: "a", ...extra }] }), "c"));
});
test("fractional geometry survives a save without becoming zero-sized", () => {
  const out = JSON.parse(json.toJsonCanvas(json.fromJsonCanvas(file([node("a", { width: 0.25, x: 0.5 })]), "c"), new Map()));
  assert.equal(out.nodes[0].width, 0.25); assert.equal(out.nodes[0].x, 0.5);
});
test("unknown link metadata cannot override node identity or geometry", () => {
  const raw = file([node("a", { type: "link", url: "https://example.com/", lattira: { link: { title: "title", id: "wrong", type: "text", width: 0 } } })]);
  const doc = json.fromJsonCanvas(raw, "c");
  assert.equal(doc.elements[0].id, "a"); assert.equal(doc.elements[0].type, "link"); assert.equal(doc.elements[0].width, 260);
  const out = JSON.parse(json.toJsonCanvas(doc, new Map()));
  assert.equal(out.nodes[0].lattira.link.id, "wrong");
});
test("async targets expire after folder deletion and workspace changes", () => {
  const ops = module("src/lib/operations.ts", ["operationTarget", "bindOperationContext", "invalidateOperations"]);
  let folder = true; let workspace = "original";
  ops.bindOperationContext(() => ({ workspace, canvasId: "same-id", active: true, hasFolder: () => folder }));
  const target = ops.operationTarget("folder"); assert.equal(target.valid(), true);
  folder = false; assert.equal(target.valid(), false);
  folder = true; workspace = "other"; assert.equal(target.valid(), false);
  workspace = "original"; ops.invalidateOperations(); assert.equal(target.valid(), false);
});
test("changed URLs start a new request and discard old preview results", async () => {
  const pending = new Map(); const patched = [];
  let card = { id: "link", type: "link", url: "https://old.example/", height: 128 };
  const api = module("src/features/canvas/links.ts", ["fetchPreview"], {
    create, useCanvasStore: { getState: () => ({ doc: { canvasId: "c", elements: [card] }, patchQuietly: async (...args) => patched.push(args) }) },
    useAppStore: { getState: () => ({ workspace: { path: "ws" }, showToast: () => {} }) },
    backend: { fetchLinkPreview: (url) => new Promise((resolve) => pending.set(url, resolve)) },
  });
  const old = api.fetchPreview(card);
  card = { ...card, url: "https://new.example/" };
  const fresh = api.fetchPreview(card);
  assert.equal(pending.size, 2);
  pending.get("https://new.example/")({ title: "new" }); await fresh;
  pending.get("https://old.example/")({ title: "old" }); await old;
  assert.equal(patched.length, 1); assert.equal(patched[0][1].link.title, "new");
});
test("file names match Windows sanitizing and retain extensionless names", () => {
  assert.equal(names.sanitizeFileName("a?b.txt"), "a_b.txt");
  assert.equal(names.sanitizeFileName("README"), "README");
  assert.equal(names.sanitizeName("CON"), "CON_");
});

async function canvas() {
  const files = new Map([["a", file([node("text")])], ["b", file([])]]);
  const calls = []; let failure = false; let block;
  const app = create(() => ({ assets: new Map(), tabs: ["a", "b"], workspace: { path: "test" }, view: { kind: "canvas", canvasId: "a" }, refreshAssets: async () => {}, canvasSaved: () => {}, showToast: () => {} }));
  const backend = {
    loadCanvas: async (id) => files.get(id),
    saveCanvas: async (id, content, index, changes) => {
      calls.push({ id, content, index, changes });
      if (block) { const wait = block; block = undefined; await wait; }
      if (failure) throw new Error("disk full");
      files.set(id, content); return { id };
    },
  };
  const { useCanvasStore: store } = module("src/store/canvasStore.ts", ["useCanvasStore"], {
    create, ...geometry, ...json, ...names, backend, useAppStore: app, t: (s) => s, uuidv7: () => crypto.randomUUID(),
    buildPreview: () => "{}", commitEditors: () => {}, bindOperationContext: () => {}, invalidateOperations: () => {},
    contentHash: async (s) => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex"),
    window: { setTimeout: () => 1, clearTimeout: () => {}, addEventListener: () => {} },
  });
  await store.getState().load("a");
  return { store, files, calls, fail: (value) => { failure = value; }, block: (promise) => { block = promise; } };
}
test("failed flush retains dirty state and retry writes the complete draft", async () => {
  const { store, calls, fail } = await canvas();
  store.getState().updateElements({ text: { text: "draft" } }); fail(true);
  await assert.rejects(store.getState().flush());
  assert.equal(store.getState().saveState, "error");
  await assert.rejects(store.getState().load("b"));
  assert.equal(store.getState().doc.canvasId, "a");
  fail(false); await store.getState().flush();
  assert.equal(store.getState().saveState, "saved");
  assert.equal(JSON.parse(calls.at(-1).content).nodes[0].text, "draft");
});
test("flush drains edits made while the preceding save is still in flight", async () => {
  const { store, files, block } = await canvas();
  let release; block(new Promise((resolve) => { release = resolve; }));
  store.getState().updateElements({ text: { text: "first" } });
  const pending = store.getState().flush();
  store.getState().updateElements({ text: { text: "second" } });
  release(); await pending;
  assert.equal(JSON.parse(files.get("a")).nodes[0].text, "second");
  assert.equal(store.getState().saveState, "saved");
});
test("viewport-only save does not rebuild text and resource indexes", async () => {
  const { store, calls } = await canvas();
  store.getState().setViewport({ x: 100, y: 200, zoom: 1 });
  await store.getState().flush(); assert.equal(calls.at(-1).index, null);
});
test("edge reversal counts as a modification", async () => {
  const { store, calls } = await canvas();
  store.getState().addElements([{ id: "other", type: "text", text: "", x: 10, y: 20, width: 100, height: 100, createdAt: 1, updatedAt: 1 }]);
  store.getState().addEdge("text", "other"); await store.getState().flush();
  store.getState().reverseEdge(store.getState().doc.edges[0].id); await store.getState().flush();
  assert.equal(calls.at(-1).changes.modified, 1);
});
test("cached tabs reload externally edited content", async () => {
  const { store, files } = await canvas();
  await store.getState().load("b"); files.set("a", file([node("text", { text: "external" })]));
  await store.getState().load("a"); assert.equal(store.getState().doc.elements[0].text, "external");
});

const folders = module("src/lib/folders.ts", ["cardName", "namesAt", "withDescendants", "canMoveInto", "folderChain", "folderName"], names);
const locations = module("src/features/assets/assetLocations.ts", ["indexAssetLocations", "loadLocationIndexes"], { ...folders, ...json });

test("asset locations preserve every folder and every occurrence, including images", () => {
  const chain = Array.from({ length: 200 }, (_, i) => node(`folder-${i}`, { type: "folder", label: `层 ${i + 1}`, parentId: i ? `folder-${i - 1}` : undefined }));
  const index = locations.indexAssetLocations([...chain, fileCard("root"), fileCard("nested", "folder-199"), node("image", { type: "image", assetId: "image-asset", parentId: "folder-199" })], "未命名文件夹");
  assert.equal(index.get("asset").length, 2);
  assert.equal(index.get("asset")[0].elementId, "root");
  assert.equal(index.get("asset")[0].folders.length, 0);
  assert.equal(index.get("asset")[1].elementId, "nested");
  assert.equal(index.get("asset")[1].folders.join(" › "), chain.map((el) => el.label).join(" › "));
  assert.equal(index.get("image-asset")[0].folders.length, 200);
});

test("location loading shares the canvas parser and supports legacy nested groups", async () => {
  const raw = file([
    node("outer", { type: "group", label: "外层", width: 1000, height: 1000 }),
    node("inner", { type: "group", label: "内层", x: 100, y: 100, width: 500, height: 500 }),
    node("card", { type: "file", file: "assets/asset.txt", x: 150, y: 150, width: 260, height: 76, lattira: { type: "file", assetId: "asset" } }),
  ]);
  let calls = 0; let received;
  await locations.loadLocationIndexes(["c", "c"], async () => { calls++; return raw; }, "未命名文件夹", () => true, (_id, index) => { received = index; }, (_id, error) => { throw error; });
  assert.equal(calls, 1);
  assert.equal(received.get("asset")[0].folders.join(" › "), "外层 › 内层");
});

test("location loading bounds concurrency and isolates an unreadable canvas", async () => {
  let inFlight = 0; let peak = 0; const delivered = [], failures = [];
  await locations.loadLocationIndexes(Array.from({ length: 12 }, (_, i) => String(i)), async (id) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1)); inFlight--;
    if (id === "3") throw new Error("unreadable");
    return file([]);
  }, "Untitled", () => true, (id) => delivered.push(id), (id) => failures.push(id));
  assert.equal(peak, 4); assert.equal(delivered.length, 11); assert.deepEqual(failures, ["3"]);
});

test("leaving the asset library stops scheduling and discards late paths", async () => {
  let active = true; let calls = 0; let release; const received = [];
  const waiting = new Promise((resolve) => { release = resolve; });
  const loading = locations.loadLocationIndexes(Array.from({ length: 12 }, (_, i) => String(i)), async () => { calls++; await waiting; return file([]); }, "Untitled", () => active, (id) => received.push(id), (id) => received.push(id));
  assert.equal(calls, 4); active = false; release(); await loading;
  assert.equal(calls, 4); assert.equal(received.length, 0);
});

function naming(elements = [], answers = []) {
  const events = []; const assets = new Map([["asset", { id: "asset", name: "one.txt", canvasIds: [] }]]);
  let active = true;
  const state = { doc: { canvasId: "c", elements }, dissolveFolder: () => events.push("dissolve") };
  const app = { assets, addAssets: (items) => items.forEach((a) => assets.set(a.id, a)), showToast: () => {} };
  const api = module("src/features/canvas/cardNames.ts", ["planNames", "resolveIncoming", "dissolveFolderNamed"], {
    ...names, ...folders, cardNameOf: folders.cardName, namesAtOf: folders.namesAt,
    useAppStore: { getState: () => app }, useCanvasStore: { getState: () => state }, t: (s) => s,
    operationTarget: () => ({ valid: () => active }),
    promptText: async () => { events.push("prompt"); return answers.shift() ?? null; },
    backend: { copyAssetAs: async (id, name) => { events.push(`copy:${name}`); return { id: `copy-${events.length}`, name }; } },
  });
  return { ...api, events, invalidate: () => { active = false; } };
}
const fileCard = (id, parentId) => node(id, { type: "file", assetId: "asset", parentId });
test("same-asset imports rename only the colliding card", async () => {
  const api = naming([], ["two.txt"]);
  const cards = await api.resolveIncoming([fileCard("a"), fileCard("b")], undefined, "ask");
  assert.equal(cards[0].assetId, "asset");
  assert.notEqual(cards[1].assetId, "asset");
  assert.deepEqual(api.events, ["prompt", "copy:two.txt"]);
});
test("incoming nested folders also resolve sibling collisions", async () => {
  const api = naming([], ["two.txt"]);
  const cards = await api.resolveIncoming([node("folder", { type: "folder", label: "folder" }), fileCard("a", "folder"), fileCard("b", "folder")], undefined, "ask");
  assert.notEqual(cards[1].assetId, cards[2].assetId);
});
test("cancelled dissolve does not rename files or dissolve the folder", async () => {
  const api = naming([node("folder", { type: "folder", label: "folder" }), fileCard("outside"), fileCard("a", "folder"), fileCard("b", "folder")], ["two.txt", null]);
  await api.dissolveFolderNamed("folder");
  assert.deepEqual(api.events, ["prompt", "prompt"]);
});
test("all names are collected before creating any copies", async () => {
  const api = naming([fileCard("outside")], ["two.txt", "three.txt"]);
  await api.resolveIncoming([fileCard("a"), fileCard("b")], undefined, "ask");
  assert.deepEqual(api.events, ["prompt", "prompt", "copy:two.txt", "copy:three.txt"]);
});

function browser(storage, blobs) {
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { if (storage.full) throw new Error("quota"); storage.set(key, value); }, removeItem: (key) => storage.delete(key) };
  return module("src/services/browserBackend.ts", ["createBrowserBackend"], {
    ...names, ...json, localStorage, t: (s) => s, uuidv7: () => crypto.randomUUID(), PROJECT_COLORS: ["#123456"], toLocalDate: () => "2026-10-11", reportImportProgress: () => {}, Blob, URL, setTimeout,
    loadFile: async (id) => blobs.get(id), storeFile: async (id, blob) => blobs.set(id, blob), removeFile: async (id) => blobs.delete(id),
    contentHash: async (s) => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex"),
  }).createBrowserBackend();
}
test("browser file bodies survive backend recreation and search includes asset ID", async () => {
  const storage = new Map(); const blobs = new Map(); const api = browser(storage, blobs);
  await api.pickWorkspace(); const [project] = await api.listProjects();
  const canvas = await api.createCanvas(project.id, "test");
  const upload = new Blob(["file content"], { type: "text/plain" }); upload.name = "README";
  const [asset] = await api.importBlobs([upload]);
  await api.saveCanvas(canvas.id, file([]), { elementCount: 1, assetIds: [asset.id], texts: [], preview: "" }, { added: 1, modified: 0, removed: 0 });
  const fresh = browser(storage, blobs); const [persisted] = await fresh.listAssets();
  assert.ok(fresh.assetUrl(persisted)); assert.equal(await blobs.get(asset.id).text(), "file content");
  assert.equal((await fresh.search("README"))[0].assetId, asset.id);
});
test("browser quota failure is reported and leaves the saved canvas intact", async () => {
  const storage = new Map(); const api = browser(storage, new Map());
  await api.pickWorkspace(); const [project] = await api.listProjects(); const canvas = await api.createCanvas(project.id, "test");
  const index = { elementCount: 1, assetIds: [], texts: [], preview: "" }; const changes = { added: 1, modified: 0, removed: 0 };
  await api.saveCanvas(canvas.id, "saved", index, changes);
  storage.full = true; await assert.rejects(api.saveCanvas(canvas.id, "draft", index, changes)); storage.full = false;
  assert.equal(await api.loadCanvas(canvas.id), "saved");
});
test("browser trash keeps independent files and rebuilds search on restore", async () => {
  const storage = new Map(), blobs = new Map(), api = browser(storage, blobs);
  await api.pickWorkspace(); const [project] = await api.listProjects(); const canvas = await api.createCanvas(project.id, "test");
  const upload = new Blob(["original"], { type: "text/plain" }); upload.name = "original.txt";
  const [asset] = await api.importBlobs([upload]);
  const raw = file([node("t", { text: "restored searchable" }), node("f", { type: "file", file: asset.path, lattira: { type: "file", assetId: asset.id } })]);
  await api.saveCanvas(canvas.id, raw, { elementCount: 2, assetIds: [asset.id], texts: [{ elementId: "t", text: "restored searchable" }], preview: "" }, { added: 2, modified: 0, removed: 0 });
  await api.deleteCanvas(canvas.id); await api.deleteAssets([asset.id]);
  assert.equal((await api.listAssets()).length, 0);
  await api.restoreTrash([{ kind: "canvas", id: canvas.id }]);
  const [restored] = await api.listAssets();
  assert.notEqual(restored.id, asset.id); assert.equal(await blobs.get(restored.id).text(), "original");
  assert.equal((await api.search("restored searchable"))[0].elementId, "t");
});
