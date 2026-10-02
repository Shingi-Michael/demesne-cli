import { driveAnswerText, type DriveRequest } from "@demesne/protocol";

/** Transport/validation retain full observations. The model gets one copy of
 * each visible row with provenance indexes, not four padded screen copies. */
export function drivePlannerInput(request: DriveRequest) {
  const screen = request.observation;
  if(request.review){
    return {...request,inspection:undefined,
      ledger:request.ledger ? {...request.ledger,tasks:request.ledger.tasks.filter(task=>task.id===request.ledger!.currentTaskId).map(task=>({...task,workerTurns:task.workerTurns.slice(-4),completions:task.completions.slice(-1).map(completion=>({...completion,evidence:[],files:completion.files.slice(0,8),checks:completion.checks.slice(0,4)}))}))} : undefined,
      facts:request.facts ? {...request.facts,files:request.facts.files.slice(0,16),checks:request.facts.checks.filter(check=>check.turnId===request.review!.turnId).slice(0,8)} : undefined,
      memory:{...request.memory,notes:request.memory.notes.slice(0,2000),completed:[],evidence:[],steps:request.memory.steps.slice(-3).map(step=>({...step,action:step.action.slice(0,300),note:step.note.slice(0,300),result:step.result.slice(0,500)}))},
      observation:{...screen,rows:[],controls:[],evidenceRows:undefined,answerRows:undefined,latestAnswerRows:undefined},
    };
  }
  if (!screen.navigation) return request;
  const reviewed = new Set(request.inspection?.pages.flatMap((page) => page.rows.map((row) => row.trim())) ?? []);
  // Rows already quoted by the inspection, and answer-card rows that are only
  // rail and padding, carry nothing new for the planner.
  const railOnly = (row: string) => /^[│▎]/.test(row.trim()) && !driveAnswerText(row);
  const rows = (screen.evidenceRows ?? screen.rows).map((row) => reviewed.has(row.trim()) || reviewed.has(driveAnswerText(row)) || railOnly(row) ? "" : row.trimEnd());
  const indexes = (source?: string[]) => rows.flatMap((row, index) => row.trim() && source?.some((text) => text.trim() && row.includes(text.trim())) ? [index] : []);
  return { ...request,
    // All task identities stay visible; older detailed evidence stays in the journal.
    ...(request.ledger ? { ledger: {...request.ledger,tasks:request.ledger.tasks.map(task=>({...task,completions:task.completions.slice(-1).map(completion=>({...completion,evidence:completion.evidence.slice(0,4)}))}))} } : {}),
    memory: { ...request.memory, steps: request.memory.steps.slice(-6).map((step) => ({ ...step, action: step.action.slice(0, 500), note: step.note.slice(0, 350), result: step.result.slice(0, 600) })) },
    observation: { ...screen, rows, evidenceRows: undefined, answerRows: undefined, latestAnswerRows: undefined,
      answerRowIndexes: indexes(screen.answerRows), latestAnswerRowIndexes: indexes(screen.latestAnswerRows) },
  };
}
