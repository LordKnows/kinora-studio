<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stave (镜谱): project notes

The app is a Next.js Studio on Cloudflare Workers (`src/`), an MCP server at `/mcp` (`src/mcp/server.ts`) and three workers (`workers/h3-runpod` renders, `workers/assembler` cuts, `workers/painter` draws). The director layer is a separate package, `packages/director`, served through the same MCP. Design: `docs/cinema-studio-h3-design.md`; the model's graphs and timings: `docs/handoff/HANDOFF.md`.

## Sources and what is generated from them

Edit the source, then run the emitter; the generated files are committed.

| Source | Generated | Command |
|---|---|---|
| `agent/director.md` (the guide the MCP serves) | `src/mcp/guide.ts` | `pnpm guide:emit` |
| `packages/director/styles/*/style.json`, `packages/director/docs/*.md` | `packages/director/styles/*/STYLE.md`, `styles/README.md`, `src/director/generated.ts` | `pnpm --filter @stave/director build`, then `pnpm guide:emit` |
| `src/studio/editing.ts`, `src/studio/cinematography.ts` | `agent/editing.md`, `agent/cinematography.md` | `pnpm guide:emit` |
| `src/db/migrations/*.ts` | `migrations/*.sql` | `pnpm db:emit` |
| `workers/h3-runpod`, `workers/assembler/handler.py`, `workers/painter` | `src/pod/bundle.ts` | `pnpm pod:bundle` |

`pnpm dev` and `pnpm build` build the director package first; `src` imports it as `@director/*` (its `dist` in tsc, its `src` in vitest).

## Checks

- `pnpm typecheck` and `pnpm test` (vitest, `tests/`).
- `pnpm --filter @stave/director test` (node:test, `packages/director/src/test`).
- `python3 -m pytest workers` for the workers (needs ffmpeg).

## Facts that were got wrong once

- **One shot is one H3 generation.** Beats are time-stamped lines inside one prompt; only separate shots and their links make separate generations.
- **The frame grid** is 17k+5 frames at 24 fps, 124 to 362, nearest. One formula, `h3Frames` in `packages/director/src/catalog.ts`; the compiler and the worker use the same rounding. A take can be shorter than its shot asks (6 s renders 5.88 s).
- **Cost is estimated as linear in length**: GPU-seconds per output second, an average per GPU type from finished takes (`gpu_stats`), times the pod's price. Two `compile_prompt` estimates made at different times differ because that average moved, not because the shots differ in length. Measured on the takes so far, a second of video costs about 1.4 times as much in takes over 7 s as in takes under 6 s; it does not quadruple.
- **Shot length and quality are unmeasured.** The 5 s default for action shots is a default from cost. Do not cite it as a finding until the length A/B (12 s against 6 + 6 `continuous`) has been run.
- **There are two guides.** `agent/director.md` is what the MCP serves as the director guide; `packages/director/docs/` are the director layer's own. A rule changed in one must be changed in the other.
- **H3 draws only the text a prompt quotes, and the Studio quotes none.** Titles, captions, signs and on-screen displays are added by the assembler, so they are exact. For the same reason a ban on text in the Look adds nothing but the word.
- **H3 has no negative prompt.** A Look's constraint, a preset's or a user style's, is a statement of what the picture shows; a ban is drawn as the thing it bans (`lintConstraints`).
- **A plan that is only prose is not held to.** The treatment (kept with the script version), the scenes' sound design rows and the timeline are structured so the lint, the story review and the export can compare them. A new planning rule goes into one of those, not only into a guide.
