// @minns/agent-forge/browser: a browser an agent can use, and repeat.
//
//   const pilot = new BrowserPilot({ driver: new PageDriver(page), llm });
//   pilot.startRecording();
//   await pilot.goto("https://example.com/login");
//   await pilot.act("fill %email% into the email field", { variables: { email } });
//   await pilot.act("click Continue");
//   const routine = pilot.stopRecording({ name: "sign in" });
//   ...
//   await pilot.replay(routine, { email });   // no model calls while the page matches

export { captureSnapshot, type PageSnapshot, type SnapshotElement, type SnapshotOptions } from "./snapshot.js";
export { COMMIT_WORDS, sameElement, stillTheSame, couldBeMoved, type Fingerprint, type FrameHop, type Target } from "./fingerprint.js";
export { resolveTarget, type Resolution, type Found } from "./resolve.js";
export {
  ELEMENT_METHODS,
  PAGE_METHODS,
  isElementMethod,
  isPageMethod,
  type BrowserDriver,
  type DriverStep,
  type ElementMethod,
  type Method,
  type PageMethod,
  type PageView,
  type StepOutcome,
} from "./driver.js";
export { PageDriver, fnv, type PageDriverOptions, type SecretMemory, type TargetMemory } from "./page-driver.js";
export {
  ACT_SYSTEM,
  OBSERVE_SYSTEM,
  EXTRACT_SYSTEM,
  buildActMessages,
  buildObserveMessages,
  buildExtractMessages,
  parseActAnswer,
  parseObserveAnswer,
  parseExtractAnswer,
  jsonIn,
  type ActAnswer,
  type ObservedAction,
} from "./prompts.js";
export { substitute, parameterize, placeholdersIn, describeVariables, valueOf, isSecretVar, type Variables, type VariableValue, type VariableSpec } from "./variables.js";
export { ROUTINE_FORMAT, parseRoutine, variablesUsed, describeStep, type Routine, type RoutineStep } from "./routine.js";
export { BrowserPilot, type PilotOptions, type ActResult, type ReplayOptions, type ReplayResult, type StepReport, type StepStatus } from "./pilot.js";
