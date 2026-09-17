import { GitCheckpointStore, type GitCheckpoint } from "./git-checkpoint.js";
export interface RevertResult { recovery: GitCheckpoint; restored: GitCheckpoint; }
export async function revertToCheckpoint(store: GitCheckpointStore, checkpoint: GitCheckpoint): Promise<RevertResult> { const recovery = await store.create(checkpoint.root, "theaihatch recovery checkpoint"); await store.restore(checkpoint); return { recovery, restored: checkpoint }; }
