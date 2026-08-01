/**
 * Production-agent patterns — small, dependency-free primitives distilled from
 * production agent systems: HITL propose-don't-execute, LLM-as-judge
 * verification, pre-model safety gating, model tiering, and conservative
 * learning guardrails.
 */
export {
  InMemoryCandidateStore,
  defaultCandidateActions,
  submitCandidate,
  effectivePayload,
  wrapToolAsCandidate,
  executeApproved,
} from "./candidate.js";
export type {
  Candidate,
  CandidateStatus,
  CandidateAction,
  CandidateResolution,
  CandidateStore,
  SubmitCandidateInput,
} from "./candidate.js";

export { Verifier } from "./verifier.js";
export type { VerifierOptions, VerifyInput, VerifyOutcome, VerifiedToolStep } from "./verifier.js";

export { SafetyGate, assertAllowed } from "./safety-gate.js";
export type { SafetyGateOptions, SafetyCheckResult, SafetyLocale } from "./safety-gate.js";

export { ModelRouter } from "./model-router.js";
export type { ModelTier, ModelTiers } from "./model-router.js";

export { LearningLoop } from "./learning-loop.js";
export type {
  LearningLoopConfig,
  LearningOutcome,
  RecordOutcomeInput,
} from "./learning-loop.js";
