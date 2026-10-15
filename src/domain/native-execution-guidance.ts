/** Guidance is not authorization: the user's scope and native tool permissions still apply. */
export const idleNativeExecutionGuidance = [
  "No active Harness Task Tree workflow. availableActions lists Task Tree workflow actions, not native tool permissions.",
  "A selected completed or archived tree does not block native project edits.",
  "Only for an unpaused conversation/direct_coding request: for small self-contained changes, use native tools without Task Tree affiliation; respect requested discussion or approval first.",
  "A paused request must stop. structured_coding requests still require their planning/approval and Attempt gates, even before a workflow exists.",
  "For a bare continuation with no unfinished authorized work, report completion and stop. Recorded warnings are history, not pending work or permission to add features or delete files.",
  "Use native judgment for other requests. Existing user scope and native permissions still apply; do not claim a Harness write block without an actual deny result.",
].join("\n");

export const pausedNativeExecutionGuidance =
  "The user paused this request. Stop without edits, cleanup, a new Task Tree, or another affiliation question. Wait for a new user request.";
