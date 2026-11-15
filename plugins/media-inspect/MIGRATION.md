# New consumer, not a kuang migration

Read deployed `kuang-deployed-0.9.0/AGENTS.md`, README, metadata, requirements/runtime.txt and core/processor.py / models.py read-only. Metadata v0.9.0, author WsureDev, repo https://github.com/WsureDev/astrbot_plugin_kuang. Processing requires Pillow/NumPy/ONNX and detection models; no isolated low-dependency business operation selected. No Python, model or plugin code executed, no formal data/credentials read or changed.

media-inspect is new independently authored MIT TypeScript business. It validates the mediaId → Worker bytes → real exported Artifact/report → Job delivery path. No source implementation is copied, no kuang feature/automatic policy/data compatibility is claimed. Model-backed detection and image rendering require a separately scoped future batch.

No subscriptions/timers, plugin-owned schedules, arbitrary network, host files or provider calls. Existing Bot Job cancellation and conservative recovery apply. Failed/unknown execution is never automatically reissued. Bundled Zod is MIT.

Deterministic local size/MIME/format/UTF-8/JSON rejection before public publication returns a failed outcome. Only the dedicated local validation error is caught. Host authority/source errors, cancellation and interruptions after publication begins retain conservative semantics; partially published artifacts remain retained and are not automatically resent.
