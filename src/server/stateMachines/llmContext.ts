import type {LlmGameContext, LlmGameContextStatus} from '../llmGameContext'
import {
  defineStateMachine,
  invalidTransition,
  transition,
  type StateMachine,
} from './core'

type LlmContextEvent =
  | {type: 'activate'}
  | {type: 'repair'}
  | {type: 'reflect'}
  | {type: 'rebase'}
  | {type: 'complete'}

const target: Record<LlmContextEvent['type'], LlmGameContextStatus> = {
  activate: 'active',
  repair: 'repairing',
  reflect: 'reflecting',
  rebase: 'needs_rebase',
  complete: 'complete',
}

export const llmContextMachine: StateMachine<LlmGameContext, LlmContextEvent> =
  defineStateMachine<LlmGameContext, LlmContextEvent>({
    name: 'LLM game context',
    state: (context) => context.status,
    transition(context, event): LlmGameContext {
      if (
        context.status === 'complete' &&
        !['complete', 'rebase'].includes(event.type)
      )
        return invalidTransition(llmContextMachine, context, event)
      return {...context, status: target[event.type]}
    },
  })

export function transitionLlmContext(
  context: LlmGameContext,
  event: LlmContextEvent,
) {
  Object.assign(context, transition(llmContextMachine, context, event))
  return context
}
