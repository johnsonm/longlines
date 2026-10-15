# Archive on Backblaze B2

The spot archive moves from the Supabase Storage bucket `archive` to a private Backblaze B2 bucket.
What is archived, the slice grain, the Parquet layout, object keys, `archive_log` and retention are
unchanged (`2026-10-11-rbn-firehose-archive-design.md`, `2026-10-14-archive-parquet-design.md`).

## Decisions

| Question          | Decision                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API               | B2's S3-compatible API, path-style. One `PutObject` per slice; the native B2 API needs an authorize and a get-upload-URL call first.                                                                                                                                                              |
| Client            | `_shared/s3.ts`: SigV4 over WebCrypto, no dependency, as with `webpush.ts`. The AWS SDK is far larger than one signed PUT and would eat into the 2 s CPU budget. Tests pin AWS's published S3 PUT and GET signatures.                                                                             |
| Payload hash      | The real SHA-256 in `x-amz-content-sha256`, not `UNSIGNED-PAYLOAD`, so a corrupted body is rejected.                                                                                                                                                                                              |
| Config            | Five function secrets, `LONGLINES_ARCHIVE_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`. Read per request; missing ones make the run answer 500 before any RPC, so slices stay pending.                                                                                            |
| Key               | Restricted to the bucket with `writeFiles` only. Readers (DuckDB) get their own `listFiles,readFiles` key.                                                                                                                                                                                        |
| Transport         | https only, except the local stack's hosts. B2 rejects plain http anyway.                                                                                                                                                                                                                         |
| Local development | The stack's Storage S3 endpoint and its `archive` bucket (still created by `20261011000004`) stand in for B2, so there is one code path and no B2 account is needed.                                                                                                                              |
| Existing objects  | Copied once with `rclone copy --ignore-existing` after the deploy (`docs/OPERATIONS.md`). Keys are identical, so `archive_log.object_path` is untouched and no migration is needed. The hosted Storage bucket is deleted by hand once `rclone check` is clean; SQL cannot delete Storage objects. |

## Out of scope

- Rewriting the old `.ndjson.gz` objects (the Parquet spec's one-off tool now reads from B2).
- Lifecycle rules, Object Lock or replication on the B2 bucket.
