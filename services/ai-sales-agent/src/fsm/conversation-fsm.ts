/**
 * @file services/ai-sales-agent/src/fsm/conversation-fsm.ts
 * @description Finite State Machine governing AI Sales Agent conversation flow.
 * States: GREETING → QUALIFY → EDUCATE → HANDLE_OBJECTION → BOOK_CALL → HANDOFF | CLOSE
 *
 * Architecture note: FSM state is persisted to Redis (not in-memory) because
 * Cloud Run is stateless. Every inbound message loads state from Redis, processes,
 * and saves. The FSM is deterministic — same state + input → same transitions,
 * which makes debugging and replay straightforward.
 *
 * We use an explicit state machine rather than an LLM-driven approach because:
 * 1. Predictable behavior at known inflection points (escalation, booking)
 * 2. Compliance — exact escalation triggers are auditable
 * 3. Cost — FSM logic is free, LLM calls are rate-limited and charged per token
 * The LLM is used only for natural language generation within each state.
 */

import type { TenantId } from '../../../../shared/src/types/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConversationState =
  | 'GREETING'
  | 'QUALIFY'
  | 'EDUCATE'
  | 'HANDLE_OBJECTION'
  | 'BOOK_CALL'
  | 'HANDOFF'
  | 'CLOSE';

export type ConversationChannel =
  | 'whatsapp'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'web';

export interface ConversationContext {
  /** Unique conversation identifier */
  conversationId: string;
  /** The CRM lead ID (set after qualification) */
  leadId: string | null;
  tenantId: TenantId;
  channel: ConversationChannel;
  externalUserId: string;
  state: ConversationState;
  /** Captured lead qualification fields */
  capturedData: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    budget: string | null;
    timeline: string | null;
    useCase: string | null;
  };
  /** Consecutive low-confidence turns */
  lowConfidenceTurns: number;
  /** Sentiment score history (last 5 turns) */
  sentimentHistory: number[];
  /** Turn count in current state */
  turnsInState: number;
  /** Total conversation turns */
  totalTurns: number;
  /** Estimated deal value (set from lead data) */
  estimatedDealValue: number | null;
  /** Whether human rep has been notified */
  humanNotified: boolean;
  /** Booking details (set in BOOK_CALL state) */
  bookingDetails: {
    calendarEventId: string | null;
    scheduledAt: string | null;
    repEmail: string | null;
  } | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface FsmInput {
  userMessage: string;
  confidenceScore: number;
  sentimentScore: number;
  /** Whether user explicitly asked for a human */
  requestedHuman: boolean;
  /** Whether booking intent detected by NLU */
  bookingIntentDetected: boolean;
  /** Whether objection detected by NLU */
  objectionDetected: boolean;
  /** Extracted entities from NLU */
  extractedEntities: Partial<ConversationContext['capturedData']>;
  /** KB retrieval found relevant results */
  hasGrounding: boolean;
}

export interface FsmOutput {
  nextState: ConversationState;
  context: ConversationContext;
  /** Whether to trigger human handoff notification */
  triggerHandoff: boolean;
  /** Whether to trigger booking flow */
  triggerBooking: boolean;
  /** System prompt instruction additions for this state */
  stateInstructions: string;
  /** Escalation reason (populated when transitioning to HANDOFF) */
  escalationReason: string | null;
}

// ─── Escalation Triggers ─────────────────────────────────────────────────────

/**
 * Multilingual escalation keywords. Checked against user message (case-insensitive).
 * The FSM checks these before any LLM processing to ensure hard-rule compliance.
 */
const ESCALATION_KEYWORDS = new Set([
  // English
  'human', 'agent', 'representative', 'rep', 'person', 'real person',
  'talk to someone', 'speak to someone', 'manager', 'supervisor',
  // Spanish
  'humano', 'agente', 'persona', 'representante', 'gerente',
  // Portuguese
  'humano', 'agente', 'pessoa', 'atendente', 'gerente',
  // French
  'humain', 'agent', 'personne', 'représentant', 'gérant',
  // German
  'mensch', 'agent', 'person', 'vertreter', 'manager',
]);

const BOOKING_KEYWORDS = new Set([
  'book', 'schedule', 'call', 'demo', 'meeting', 'appointment',
  'talk', 'chat', 'agendar', 'reunión', 'cita', 'rendez-vous',
  'termin', 'buchung',
]);

/**
 * Check if message contains escalation trigger keywords.
 * Normalized to lower-case, special chars stripped.
 */
export function containsEscalationKeyword(message: string): boolean {
  const normalized = message.toLowerCase().replace(/[^\w\s]/g, ' ');
  const words = normalized.split(/\s+/);
  return words.some(word => ESCALATION_KEYWORDS.has(word)) ||
    normalized.includes('real person') ||
    normalized.includes('talk to someone') ||
    normalized.includes('speak to someone');
}

export function containsBookingKeyword(message: string): boolean {
  const normalized = message.toLowerCase();
  return Array.from(BOOKING_KEYWORDS).some(kw => normalized.includes(kw));
}

// ─── FSM Transition Engine ───────────────────────────────────────────────────

export class ConversationFsm {
  /**
   * Process a single turn through the FSM.
   * Returns the next state and any side-effect triggers.
   * Pure function of (context, input) — all side effects handled by caller.
   */
  transition(context: ConversationContext, input: FsmInput): FsmOutput {
    // ── Hard-rule: explicit human request always wins ──────────────────────
    if (input.requestedHuman || containsEscalationKeyword(input.userMessage)) {
      return this.transitionToHandoff(context, 'User requested human agent');
    }

    // ── Hard-rule: sustained low confidence triggers handoff ───────────────
    const updatedLowConf = input.confidenceScore < 0.65
      ? context.lowConfidenceTurns + 1
      : 0;

    if (updatedLowConf >= 3) {
      return this.transitionToHandoff(
        { ...context, lowConfidenceTurns: updatedLowConf },
        'AI confidence below threshold for 3 consecutive turns'
      );
    }

    // ── Hard-rule: sustained negative sentiment triggers handoff ───────────
    const updatedSentiment = [
      ...context.sentimentHistory.slice(-4),
      input.sentimentScore,
    ];
    const recentNegative = updatedSentiment.slice(-2).filter(s => s < -0.5).length;
    if (recentNegative >= 2) {
      return this.transitionToHandoff(
        { ...context, sentimentHistory: updatedSentiment },
        'User expressing sustained negative sentiment'
      );
    }

    // ── Hard-rule: high deal value auto-escalates ──────────────────────────
    if (
      context.estimatedDealValue !== null &&
      context.estimatedDealValue > (this.getDealValueThreshold(context))
    ) {
      return this.transitionToHandoff(
        context,
        `Deal value $${context.estimatedDealValue} exceeds auto-escalation threshold`
      );
    }

    // ── Update context with newly captured entities ────────────────────────
    const updatedCapturedData = {
      ...context.capturedData,
      ...this.filterNonNullEntities(input.extractedEntities),
    };

    const updatedContext: ConversationContext = {
      ...context,
      capturedData: updatedCapturedData,
      lowConfidenceTurns: updatedLowConf,
      sentimentHistory: updatedSentiment,
      turnsInState: context.turnsInState + 1,
      totalTurns: context.totalTurns + 1,
      lastActivityAt: new Date().toISOString(),
    };

    // ── State machine transitions ──────────────────────────────────────────
    switch (context.state) {
      case 'GREETING':
        return this.fromGreeting(updatedContext, input);
      case 'QUALIFY':
        return this.fromQualify(updatedContext, input);
      case 'EDUCATE':
        return this.fromEducate(updatedContext, input);
      case 'HANDLE_OBJECTION':
        return this.fromHandleObjection(updatedContext, input);
      case 'BOOK_CALL':
        return this.fromBookCall(updatedContext, input);
      default:
        // Terminal states — no further transitions
        return {
          nextState: context.state,
          context: updatedContext,
          triggerHandoff: false,
          triggerBooking: false,
          stateInstructions: '',
          escalationReason: null,
        };
    }
  }

  private fromGreeting(ctx: ConversationContext, input: FsmInput): FsmOutput {
    // Move to QUALIFY on any substantive response
    const hasName = !!input.extractedEntities.name;
    const nextState: ConversationState = 'QUALIFY';

    return {
      nextState,
      context: { ...ctx, state: nextState, turnsInState: 0 },
      triggerHandoff: false,
      triggerBooking: false,
      stateInstructions: this.getStateInstructions(nextState, ctx),
      escalationReason: null,
    };
  }

  private fromQualify(ctx: ConversationContext, input: FsmInput): FsmOutput {
    const data = ctx.capturedData;
    const qualificationComplete =
      !!data.name &&
      !!(data.email || data.phone) &&
      !!(data.useCase || data.budget);

    // If they ask about the product before fully qualified, enter EDUCATE
    // and continue qualifying with questions woven in
    if (input.hasGrounding && ctx.turnsInState >= 1) {
      const nextState: ConversationState = 'EDUCATE';
      return {
        nextState,
        context: { ...ctx, state: nextState, turnsInState: 0 },
        triggerHandoff: false,
        triggerBooking: false,
        stateInstructions: this.getStateInstructions(nextState, ctx),
        escalationReason: null,
      };
    }

    if (qualificationComplete || ctx.turnsInState >= 5) {
      const nextState: ConversationState = 'EDUCATE';
      return {
        nextState,
        context: { ...ctx, state: nextState, turnsInState: 0 },
        triggerHandoff: false,
        triggerBooking: false,
        stateInstructions: this.getStateInstructions(nextState, ctx),
        escalationReason: null,
      };
    }

    // Stay in QUALIFY
    return {
      nextState: 'QUALIFY',
      context: ctx,
      triggerHandoff: false,
      triggerBooking: false,
      stateInstructions: this.getStateInstructions('QUALIFY', ctx),
      escalationReason: null,
    };
  }

  private fromEducate(ctx: ConversationContext, input: FsmInput): FsmOutput {
    if (input.objectionDetected) {
      const nextState: ConversationState = 'HANDLE_OBJECTION';
      return {
        nextState,
        context: { ...ctx, state: nextState, turnsInState: 0 },
        triggerHandoff: false,
        triggerBooking: false,
        stateInstructions: this.getStateInstructions(nextState, ctx),
        escalationReason: null,
      };
    }

    if (input.bookingIntentDetected || containsBookingKeyword(input.userMessage)) {
      const nextState: ConversationState = 'BOOK_CALL';
      return {
        nextState,
        context: { ...ctx, state: nextState, turnsInState: 0 },
        triggerHandoff: false,
        triggerBooking: true,
        stateInstructions: this.getStateInstructions(nextState, ctx),
        escalationReason: null,
      };
    }

    // Stay in EDUCATE
    return {
      nextState: 'EDUCATE',
      context: ctx,
      triggerHandoff: false,
      triggerBooking: false,
      stateInstructions: this.getStateInstructions('EDUCATE', ctx),
      escalationReason: null,
    };
  }

  private fromHandleObjection(ctx: ConversationContext, input: FsmInput): FsmOutput {
    // After handling objection, return to EDUCATE (1 objection max before BOOK push)
    if (ctx.turnsInState >= 2) {
      const nextState: ConversationState = ctx.turnsInState >= 4 ? 'BOOK_CALL' : 'EDUCATE';
      return {
        nextState,
        context: { ...ctx, state: nextState, turnsInState: 0 },
        triggerHandoff: false,
        triggerBooking: nextState === 'BOOK_CALL',
        stateInstructions: this.getStateInstructions(nextState, ctx),
        escalationReason: null,
      };
    }

    return {
      nextState: 'HANDLE_OBJECTION',
      context: ctx,
      triggerHandoff: false,
      triggerBooking: false,
      stateInstructions: this.getStateInstructions('HANDLE_OBJECTION', ctx),
      escalationReason: null,
    };
  }

  private fromBookCall(ctx: ConversationContext, input: FsmInput): FsmOutput {
    const isBooked = !!ctx.bookingDetails?.scheduledAt;

    if (isBooked) {
      const nextState: ConversationState = 'CLOSE';
      return {
        nextState,
        context: { ...ctx, state: nextState, turnsInState: 0 },
        triggerHandoff: false,
        triggerBooking: false,
        stateInstructions: this.getStateInstructions(nextState, ctx),
        escalationReason: null,
      };
    }

    // Still in booking flow
    return {
      nextState: 'BOOK_CALL',
      context: ctx,
      triggerHandoff: false,
      triggerBooking: true,
      stateInstructions: this.getStateInstructions('BOOK_CALL', ctx),
      escalationReason: null,
    };
  }

  private transitionToHandoff(context: ConversationContext, reason: string): FsmOutput {
    const updatedContext: ConversationContext = {
      ...context,
      state: 'HANDOFF',
      humanNotified: false, // Will be set to true after notification sent
      lastActivityAt: new Date().toISOString(),
    };

    return {
      nextState: 'HANDOFF',
      context: updatedContext,
      triggerHandoff: true,
      triggerBooking: false,
      stateInstructions: this.getStateInstructions('HANDOFF', updatedContext),
      escalationReason: reason,
    };
  }

  /**
   * State-specific instructions appended to the system prompt.
   * These guide the LLM's behavior without overriding the base personality.
   */
  getStateInstructions(state: ConversationState, ctx: ConversationContext): string {
    const missingFields = this.getMissingQualificationFields(ctx.capturedData);

    switch (state) {
      case 'GREETING':
        return 'Warmly greet the user and introduce yourself. Ask for their name to personalize the conversation.';

      case 'QUALIFY':
        return missingFields.length > 0
          ? `Focus on gathering qualification information naturally. Still missing: ${missingFields.join(', ')}. Weave ONE qualifying question into your response naturally — don't interrogate.`
          : 'Qualification complete. Transition smoothly to discussing the product.';

      case 'EDUCATE':
        return 'Answer the user\'s questions using ONLY the verified knowledge base above. Highlight relevant benefits. After answering, naturally guide toward scheduling a demo.';

      case 'HANDLE_OBJECTION':
        return 'Acknowledge the concern empathetically. Address it with specific facts from the knowledge base. Offer social proof if available. Then pivot back toward value.';

      case 'BOOK_CALL':
        return `Guide the user to schedule a call. Collect: preferred time, email for calendar invite.${
          ctx.capturedData.email ? '' : ' Still need their email.'
        } Present exactly 2 time slot options.`;

      case 'HANDOFF':
        return 'Warmly inform the user you\'re connecting them with a team member who can better assist. Provide an estimated wait time if known. Be reassuring.';

      case 'CLOSE':
        return `Confirm the scheduled call details: ${ctx.bookingDetails?.scheduledAt ?? 'pending'}. Thank them warmly. Provide any preparation tips if relevant.`;
    }
  }

  private getMissingQualificationFields(
    data: ConversationContext['capturedData']
  ): string[] {
    const required = [
      ['name', data.name],
      ['email or phone', data.email ?? data.phone],
      ['use case', data.useCase],
    ] as const;
    return required.filter(([, v]) => !v).map(([k]) => k);
  }

  private getDealValueThreshold(ctx: ConversationContext): number {
    // TODO: load from tenant settings — defaulting to $10k for auto-escalation
    return 10_000;
  }

  private filterNonNullEntities(
    entities: Partial<ConversationContext['capturedData']>
  ): Partial<ConversationContext['capturedData']> {
    return Object.fromEntries(
      Object.entries(entities).filter(([, v]) => v !== null && v !== undefined)
    );
  }
}

// ─── Context Factory ──────────────────────────────────────────────────────────

export function createConversationContext(
  conversationId: string,
  tenantId: TenantId,
  channel: ConversationChannel,
  externalUserId: string
): ConversationContext {
  return {
    conversationId,
    leadId: null,
    tenantId,
    channel,
    externalUserId,
    state: 'GREETING',
    capturedData: {
      name: null,
      email: null,
      phone: null,
      company: null,
      budget: null,
      timeline: null,
      useCase: null,
    },
    lowConfidenceTurns: 0,
    sentimentHistory: [],
    turnsInState: 0,
    totalTurns: 0,
    estimatedDealValue: null,
    humanNotified: false,
    bookingDetails: null,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}
