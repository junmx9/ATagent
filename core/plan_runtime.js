"use strict";

const { getMissingParams } = require("./ai");
const { deepClone } = require("./utils");

async function executePlan({
  input,
  plan,
  context = {},
  actions,
  messages,
  conversations,
  actionResolver,
  executeAction,
  buildClarifyQuestion,
  configVersion,
  planEngine,
  maxPlanSteps = 6,
  maxPlanReplans = 2
}) {
  const planId = await conversations.createPlanSession(null, {
    goal: plan.goal || input,
    originalInput: input,
    remainingSteps: clone(plan.steps || []),
    completedSteps: [],
    pendingStep: null,
    maxPlanSteps,
    maxPlanReplans,
    replanCount: 0,
    configVersion
  });

  const planSession = await conversations.getPlanSession(planId);
  return continuePlanLoop({
    planSession,
    context,
    actions,
    messages,
    conversations,
    actionResolver,
    executeAction,
    buildClarifyQuestion,
    configVersion,
    planEngine
  });
}

async function resumePlanAfterAction({
  planSessionId,
  stepResult,
  context = {},
  actions,
  messages,
  conversations,
  actionResolver,
  executeAction,
  buildClarifyQuestion,
  configVersion,
  planEngine
}) {
  const planSession = await conversations.getPlanSession(planSessionId);
  if (!planSession) {
    return {
      status: "unresolved",
      message: messages.unresolved
    };
  }

  if (planSession.configVersion !== configVersion) {
    await conversations.clearPlanSession(planSessionId);
    return {
      status: "unresolved",
      message: messages.configChanged
    };
  }

  return continuePlanLoop({
    planSession,
    context,
    actions,
    messages,
    conversations,
    actionResolver,
    executeAction,
    buildClarifyQuestion,
    configVersion,
    planEngine,
    currentOutcome: {
      step: clone(planSession.pendingStep),
      result: normalizeStepResult(stepResult)
    }
  });
}

async function continuePlanLoop({
  planSession,
  context,
  actions,
  messages,
  conversations,
  actionResolver,
  executeAction,
  buildClarifyQuestion,
  configVersion,
  planEngine,
  currentOutcome = null
}) {
  let session = clone(planSession);

  while (true) {
    if (currentOutcome) {
      const afterOutcome = await applyStepOutcome({
        session,
        outcome: currentOutcome,
        context,
        actions,
        messages,
        conversations,
        configVersion,
        planEngine
      });
      if (afterOutcome.finalResult) {
        return afterOutcome.finalResult;
      }
      session = afterOutcome.session;
      currentOutcome = null;
      continue;
    }

    const nextStep = shiftNextStep(session);
    if (!nextStep) {
      await conversations.clearPlanSession(session.id);
      return buildPlanSuccess(session, {
        message: messages.success
      });
    }

    const action = actionResolver(nextStep.action);
    if (!action || !action.enabled) {
      currentOutcome = {
        step: nextStep,
        result: {
          status: "error",
          action: nextStep.action,
          message: `Plan step "${nextStep.id}" references unavailable action "${nextStep.action}".`,
          error: {
            code: "plan_missing_action"
          }
        }
      };
      continue;
    }

    const missingParams = getMissingParams(action, nextStep.params || {});
    if (missingParams.length > 0) {
      await conversations.updatePlanSession(session.id, {
        remainingSteps: clone(session.remainingSteps),
        completedSteps: clone(session.completedSteps),
        pendingStep: clone(nextStep),
        updatedAt: Date.now()
      });
      return pauseForClarification({
        planId: session.id,
        step: nextStep,
        action,
        messages,
        conversations,
        configVersion,
        originalInput: session.originalInput,
        params: nextStep.params || {},
        missingParams,
        buildClarifyQuestion
      });
    }

    const stepResult = await executeAction({
      action,
      params: nextStep.params || {},
      context,
      sessionId: session.id,
      configVersion,
      confirmationMeta: {
        planSessionId: session.id,
        planStepId: nextStep.id
      }
    });

    if (stepResult.status === "requires_confirmation") {
      await conversations.updatePlanSession(session.id, {
        remainingSteps: clone(session.remainingSteps),
        completedSteps: clone(session.completedSteps),
        pendingStep: clone(nextStep),
        updatedAt: Date.now()
      });
      return {
        ...stepResult,
        mode: "goal",
        planId: session.id,
        current_step: toPublicStep(nextStep)
      };
    }

    currentOutcome = {
      step: nextStep,
      result: normalizeStepResult(stepResult)
    };
  }
}

function shiftNextStep(session) {
  if (session.pendingStep) {
    const step = clone(session.pendingStep);
    session.pendingStep = null;
    return step;
  }

  if (!Array.isArray(session.remainingSteps) || session.remainingSteps.length === 0) {
    return null;
  }

  return session.remainingSteps.shift();
}

async function applyStepOutcome({
  session,
  outcome,
  context,
  actions,
  messages,
  conversations,
  configVersion,
  planEngine
}) {
  const completedSteps =
    outcome.result.status === "success"
      ? [
          ...session.completedSteps,
          {
            step: clone(outcome.step),
            result: clone(outcome.result)
          }
        ]
      : clone(session.completedSteps);

  if (completedSteps.length > session.maxPlanSteps) {
    await conversations.clearPlanSession(session.id);
    return {
      finalResult: buildPlanError({
        session,
        step: outcome.step,
        result: outcome.result,
        code: "plan_step_limit_exceeded",
        message: `Plan exceeded the max step limit (${session.maxPlanSteps}).`
      })
    };
  }

  const decision = await planEngine.decideNext({
    goal: session.goal,
    actions,
    context,
    completedSteps: completedSteps.map(toPlannerCompletedStep),
    remainingSteps: clone(session.remainingSteps),
    lastOutcome: {
      step: toPublicStep(outcome.step),
      result: clone(outcome.result)
    },
    maxSteps: session.maxPlanSteps
  });

  if (decision.type === "error") {
    await conversations.clearPlanSession(session.id);
    return {
      finalResult: {
        status: "error",
        mode: "goal",
        message: decision.error.message,
        error: decision.error,
        planId: session.id
      }
    };
  }

  if (decision.type === "fail") {
    await conversations.clearPlanSession(session.id);
    return {
      finalResult: buildPlanError({
        session,
        step: outcome.step,
        result: outcome.result,
        code: "plan_failed",
        message: decision.message || outcome.result.message || "计划执行失败。"
      })
    };
  }

  const replanCount =
    decision.steps !== undefined ? session.replanCount + 1 : session.replanCount;
  if (replanCount > session.maxPlanReplans) {
    await conversations.clearPlanSession(session.id);
    return {
      finalResult: buildPlanError({
        session,
        step: outcome.step,
        result: outcome.result,
        code: "plan_replan_limit_exceeded",
        message: `Plan exceeded the max replan limit (${session.maxPlanReplans}).`
      })
    };
  }

  const nextSession = {
    ...session,
    completedSteps,
    pendingStep: null,
    replanCount,
    remainingSteps:
      decision.steps !== undefined ? clone(decision.steps) : clone(session.remainingSteps)
  };

  if (decision.type === "complete" || nextSession.remainingSteps.length === 0) {
    await conversations.clearPlanSession(session.id);
    return {
      finalResult: buildPlanSuccess(nextSession, {
        message:
          decision.message ||
          outcome.result.message ||
          lastCompletedMessage(nextSession) ||
          messages.success
      })
    };
  }

  const stored = await conversations.updatePlanSession(session.id, {
    completedSteps: clone(nextSession.completedSteps),
    pendingStep: null,
    replanCount: nextSession.replanCount,
    remainingSteps: clone(nextSession.remainingSteps),
    updatedAt: Date.now()
  });

  return {
    session: stored || nextSession
  };
}

async function pauseForClarification({
  planId,
  step,
  action,
  messages,
  conversations,
  configVersion,
  originalInput,
  params,
  missingParams,
  buildClarifyQuestion
}) {
  const sessionId = await conversations.createClarification(null, {
    actionName: action.name,
    params: clone(params),
    missingParams: clone(missingParams),
    clarifyRound: 1,
    configVersion,
    originalInput,
    mode: "goal",
    planSessionId: planId,
    planStep: toPublicStep(step),
    updatedAt: Date.now()
  });

  return {
    status: "needs_more_info",
    mode: "goal",
    action: action.name,
    missing_params: missingParams,
    question:
      buildClarifyQuestion(action, missingParams) || messages.askClarify,
    clarifyRound: 1,
    sessionId,
    planId,
    current_step: toPublicStep(step)
  };
}

function buildPlanSuccess(session, { message }) {
  return {
    status: "success",
    mode: "goal",
    planId: session.id,
    message,
    data: {
      goal: session.goal,
      completed_steps: session.completedSteps.map((entry) => ({
        step: toPublicStep(entry.step),
        result: clone(entry.result)
      })),
      lastStep: lastCompletedStep(session)
    }
  };
}

function buildPlanError({ session, step, result, code, message }) {
  return {
    status: "error",
    mode: "goal",
    planId: session.id,
    message,
    failedStep: step ? step.id : undefined,
    error: {
      code,
      cause: result.error || undefined
    },
    data: {
      goal: session.goal,
      completed_steps: session.completedSteps.map((entry) => ({
        step: toPublicStep(entry.step),
        result: clone(entry.result)
      })),
      lastOutcome: {
        step: step ? toPublicStep(step) : null,
        result: clone(result)
      }
    }
  };
}

function normalizeStepResult(result) {
  return result && typeof result === "object" ? clone(result) : { status: "error" };
}

function lastCompletedStep(session) {
  if (!Array.isArray(session.completedSteps) || session.completedSteps.length === 0) {
    return null;
  }
  const last = session.completedSteps[session.completedSteps.length - 1];
  return {
    step: toPublicStep(last.step),
    result: clone(last.result)
  };
}

function lastCompletedMessage(session) {
  const last = lastCompletedStep(session);
  return last?.result?.message || "";
}

function toPublicStep(step) {
  if (!step) {
    return null;
  }
  return {
    id: step.id,
    action: step.action,
    params: clone(step.params || {}),
    purpose: step.purpose || ""
  };
}

function toPlannerCompletedStep(entry) {
  return {
    step: toPublicStep(entry.step),
    result: clone(entry.result)
  };
}

function clone(value) {
  return value === undefined ? undefined : deepClone(value);
}

module.exports = {
  executePlan,
  resumePlanAfterAction
};
