import { classifyCommand, requireCommandApproval, type CommandDecision } from "@theaihatch/safety";
import { createShellPolicy, createPathPolicy, type PathPolicy } from "@theaihatch/safety";
import { DryRunRecorder } from "@theaihatch/safety";

export interface InboundPolicy { pathPolicy: PathPolicy; dryRun: DryRunRecorder; command(command: string, cwd: string, approved: boolean): Promise<CommandDecision>; }
export async function createInboundPolicy(root: string, dryRun = false): Promise<InboundPolicy> { const pathPolicy = await createPathPolicy(root); const shellPolicy = await createShellPolicy(root); return { pathPolicy, dryRun: new DryRunRecorder(dryRun), command: async (command, cwd, approved) => { const decision = classifyCommand(command, await shellPolicy.workingDirectory(cwd)); requireCommandApproval(decision, approved); return decision; } }; }
