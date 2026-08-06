# Migration provenance

This tool was migrated from `/Users/ramakanth/pers/self-voice-clone` at commit:

```text
e8347a8ca253572709ed11cec88ecd4538a5290b
```

The migration intentionally captured the source working tree, including its uncommitted API, Sanskrit normalization, adaptation, engine, frontend-contract, test, and documentation changes. The original repository was left unchanged and was not embedded as a nested Git repository.

The FastAPI application retains its original `vclone/apps/api` layout to keep database and upload paths stable. The Next.js UI was converted into the native React implementation in `src/ui/`. Local virtual environments, `node_modules`, `.next`, caches, bulk training media, training runs, notebooks, and standalone generated examples were not imported.
