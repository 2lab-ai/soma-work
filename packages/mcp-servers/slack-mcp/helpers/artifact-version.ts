/**
 * #1074 — the version an upload is, said in the upload itself: planned against the session's artifact index with
 * the rule the daemon's store records it by. The implementation is shared with the daemon (its hand-off test reads
 * both sides) and reaches this process through @soma/process-shared.
 */
export * from '@soma/process-shared/artifacts/upload-version.js';
