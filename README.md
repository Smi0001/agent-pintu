# @smi0001/agent-pintu

PR call-graph tracer for **TypeScript and JavaScript** Express/Fastify/Koa-style servers. Given a branch with changes, walks the AST from each touched route handler and emits two artifacts you can paste into a PR or hand to another AI:

- **`PR-<n>-<slug>.md`** — human view: title, combined Mermaid flowchart, per-route Mermaid + table, "touched code not reached" section. Renders as a picture in GitHub / Gitea.
- **`PR-<n>-<slug>.yaml`** — machine view: structured `entry_routes`, `nodes`, `edges`, timestamps. An AI/tool can read this and skip re-walking the codebase.

Static analysis only — no LLM calls, no token cost per run.

## Install

```bash
# On demand
npx @smi0001/agent-pintu init
npx @smi0001/agent-pintu trace --pr-num 42 --title "Order Checkout"

# Or globally
npm i -g @smi0001/agent-pintu
agent-pintu --help
```

Requires Node 18+. Works on any git repo whose server code is TypeScript and whose tsconfig.json compiles cleanly.

## Configure

Drop a `.pintu.json` in your project root:

```bash
cd /path/to/your/project
agent-pintu init
```

```json
{
  "project": ".",
  "serverRoot": "server",
  "tsConfig": "server/tsconfig.json",
  "appEntry": "server/app.ts",
  "baseBranch": "main",
  "outDir": "documents/pr-traces",
  "routesPattern": "/routes/",
  "depth": 4
}
```

Paths in `.pintu.json` resolve relative to the config file's location, so `agent-pintu` works no matter what dir you run it from. CLI flags (e.g. `--pr-num`, `--title`, `--base`) override config.

Config search walks up from the current dir to find `.pintu.json` — handy if you `cd` into a subdirectory of your project.

## Usage

```bash
# Trace the current branch vs base (auto-detects main / master / develop)
agent-pintu trace --pr-num 42 --title "Order Checkout"

# Override base branch
agent-pintu trace --base develop --pr-num 42

# Run against a different repo
agent-pintu trace --project /path/to/other/repo --pr-num 7

# All flags
agent-pintu --help
```

## What it does

1. `git diff --name-only <base>...HEAD` → changed files.
2. Loads the TS project with [`ts-morph`](https://ts-morph.com/) (`<server-root>/tsconfig.json`).
3. In every changed `.ts` route file (`routesPattern` substring match), finds:
   - `router.route(path).METHOD(handler)` chains
   - `router.METHOD(path, handler)` calls
4. Walks the AST from each handler. For each `CallExpression`, resolves the called symbol's declaration via the TS type checker. Recurses up to `depth` hops; cycle-safe via a visited set.
5. For each in-project symbol: marks `touched_in_pr` if any line of its body intersects a diff hunk; runs `git log -L <start>,<end>:<file>` to extract `created` / `updated` ISO timestamps.
6. External calls (node_modules) become terminal nodes. Stdlib noise (`res.json`, `console.log`, `Array.push`, `JSON.stringify`, etc.) is filtered.
7. Detects the mount-prefix chain from `app.ts` (`app.use("/_", api)` + `api.use("/orders", router)` → `/_/orders`).

Mermaid color coding:

- 🟧 Orange — function touched by this PR
- 🟦 Blue — route entry handler
- ⬜ Gray — external / library symbol

## Output schema (`.yaml`)

```yaml
pr: "42"
title: "Order Checkout"
base_branch: "develop"
generated_at: "2026-06-03T..."
tool: agent-pintu v0.1.0
entry_routes:
  - method: POST
    path: "/_/orders/start"
    handler: "createOrder"
    route_file: "server/src/routes/ordersRoutes.ts"
nodes:
  - id: "server/src/controllers/ordersController.ts:createOrder"
    name: createOrder
    file: server/src/controllers/ordersController.ts
    line: 95
    end_line: 232
    kind: entry          # entry | internal | external
    touched_in_pr: true
    routes: ["POST /_/orders/start"]
    created: "2026-05-17T04:11:07+05:30"
    updated: "2026-05-17T04:11:07+05:30"
edges:
  - from: "server/src/controllers/ordersController.ts:createOrder"
    to:   "server/src/controllers/ordersController.ts:requireAuth"
    call_sites:
      - line: 138
        args: ["payload"]
```

## Trace modes (v0.3)

Pintu now has **two ways to pick entry points**, selected via `--mode` or the interactive prompt:

| Mode | Entry points | Best for |
|---|---|---|
| **`routes`** (default for backend servers) | Express route handlers detected in changed route files (`router.METHOD(path, handler)` or `router.route(path).METHOD(handler)`) | Backend Node services with HTTP routes — answers "what URLs does this PR affect?" |
| **`touched`** | Every top-level function (and class method) whose body intersects a diff hunk | Any project — frontend SPAs, libraries, CLIs, monorepos without classic Express routes. Answers "what functions changed and what do they call?" |

If you don't pass `--mode` and don't set `mode` in `.pintu.json`, pintu prompts you interactively (or defaults to `routes` in non-TTY contexts like CI).

```bash
agent-pintu trace --pr-num 42 --title "..."             # interactive prompt
agent-pintu trace --mode touched --pr-num 42 --title "..."  # explicit, no prompt
```

For CI, pin the mode in `.pintu.json` or pass `--mode` so the run is deterministic.

## Scope (v0.3)

- **TypeScript and JavaScript.** Walks `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`. When `tsConfig` is set (or `tsconfig.json` exists at the server or project root), pintu loads the project from it. **For JS-only projects without a tsconfig**, pintu synthesizes a ts-morph project with `allowJs: true` — just leave `tsConfig` unset in your `.pintu.json` (or omit the file).
- **Route handlers — named or inline (routes mode).** Both `router.get(path, namedHandler)` and `router.get(path, async (req, res) => {...})` are detected. Inline handlers get a synthetic label like `<inline get@L22>`.
- **Top-level functions and class methods (touched mode).** Nested arrow functions inside other functions are skipped to avoid graph explosion.
- **Doesn't trace client-side framework routers** (Durandal, Knockout, React Router, Vue Router, etc.) in routes mode. For frontend projects, use `--mode touched`.
- **Arg labels are source text, not type-resolved.** Edge labels show the literal source of the first 1–2 arguments (capped at 60 chars).
- **Mount-prefix detection** (routes mode) uses suffix-matching on import paths in `appEntry` and only resolves plain string / no-substitution template prefixes. Template literals with variable substitutions (e.g. `app.use(\`${BASE_PATH}/api\`, router)`) currently fall back to router-local paths — roadmap item.

## Composition with [agent-binod](https://www.npmjs.com/package/@smi0001/agent-binod)

The pair works well together: run `agent-pintu` first to generate the `.yaml`, then point `agent-binod` at the PR — binod's review gets free structural context ("you touched 6 routes; here's the call graph") at near-zero token cost vs re-parsing the source.

## Known limitations / roadmap

- **Mount prefixes from template literals with variables** — e.g. `app.use(\`${BASE_PATH}/api\`, router)` currently falls back to router-local paths.
- **Cross-stack stitching** — pick up `axios.get('/_/...')` / `fetch('/_/...')` calls in client code and join them into matching route entries.
- **Test coverage overlay** — flag which nodes have a corresponding `*.test.{ts,js}` reference.
- **`<out-dir>/index.yaml`** — one-line entry per generated trace so future agents can grep instead of scanning the directory.
- **Type-resolved arg labels.**
- **Pre-push hook / Gitea webhook** — auto-generate on PR open, commit the pair back to the branch.
- **Python / Go / other languages** — different ASTs entirely; would ship as sibling packages with a shared core, only when there's a concrete project to point each one at.

## License

MIT © Shammi Hans
