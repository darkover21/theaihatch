# ADR-0006: Runtime cache root trust boundary

## Decision

Treat `THEAIHATCH_RUNTIME_CACHE` (or the packaged user-data runtime directory) as trusted operator input. Create and canonicalize that root once, then reject symlinks, non-directories, and canonical paths escaping the root only for directories and assets inside it.

## Rationale

Valid cache roots can live below operating-system symlinked ancestors such as macOS `/var`. Rejecting every symlink above the cache root breaks legitimate systems without protecting the cache contents. The threat boundary is a hostile symlink planted inside the cache tree.

## Consequences

The cache root may resolve through an ancestor symlink, while intermediate asset directories remain strictly checked. Asset files continue to use exclusive publication and SHA-256 verification.
