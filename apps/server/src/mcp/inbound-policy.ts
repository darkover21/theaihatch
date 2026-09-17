import { classifyCommand, requireCommandApproval, type CommandDecision } from "@theaihatch/safety";
import { createPathPolicy, type PathPolicy } from "@theaihatch/safety";
import { DryRunRecorder } from "@theaihatch/safety";

export interface InboundPolicy { pathPolicy: PathPolicy; dryRun: DryRunRecorder; command(command: string, cwd: string, approved: boolean): CommandDecision; }
export async function createInboundPolicy(root: string, dryRun = false): Promise<InboundPolicy> { const pathPolicy = await createPathPolicy(root); return { pathPolicy, dryRun: new DryRunRecorder(dryRun), command: (command, cwd, approved) => { const decision = classifyCommand(command, cwd); requireCommandApproval(decision, approved); return decision; } }; }
