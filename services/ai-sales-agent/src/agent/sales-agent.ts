/**
 * @file services/ai-sales-agent/src/agent/sales-agent.ts
 * @description Core AI Sales Agent — orchestrates NLU, RAG, FSM, and response generation.
 *
 * Turn processing pipeline:
 * 1. Load conversation context from Redis
 * 2. Run NLU (entity extraction, intent, sentiment) via Gemini Flash (cheap+fast)
 * 3. Retrieve grounding context from Vector Search (RAG)
 * 4. Run FSM transition to get next state + instructions
 * 5. Generate response via Gemini Pro with grounding + persona + state instructions
 * 6. Detect confidence from response metadata
 * 7. Persist updated context + conversation turn to DB
 * 8. Return response message
 */

import { VertexAI, type GenerateContentRequest } from '@google-cloud/vertexai';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { TenantId } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';
import { KnowledgeBaseRetriever } from '../rag/knowledge-base.js';
import {
  ConversationFsm,
  createConversationContext,
  containsEscalationKeyword,
  containsBookingKeyword,
  type ConversationContext,
  type ConversationChannel,
  type FsmInput,
} from '../fsm/conversation-fsm.js';
import { getTenantClient } from '../../../../shared/src/utils/database.js';
import { publishEvent, TOPICS } from '../../../../shared/src/utils/pubsub.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentMessage {
  messageId: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  channel: ConversationChannel;
  externalUserId: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface TenantAgentConfig {
  tenantId: TenantId;
  agentName: string;
  agentPersona: string;
  businessName: string;
  dealValueThreshold: number;
  calendarLink: string | null;
  humanHandoffEmail: string;
  languageCode: string;
}

export interface ProcessMessageResult {
  outboundMessage: string;
  conversationId: string;
  state: string;
  triggerHandoff: boolean;
  triggerBooking: boolean;
  escalationReason: string | null;
  leadCreated: boolean;
  leadId: string | null;
}

interface NluResult {
  intent: string;
  sentimentScore: number;
  entities: Partial<ConversationContext['capturedData']>;
  hasObjection: boolean;
  hasBookingIntent: boolean;
  confidenceScore: number;
}

const CONTEXT_TTL_SECONDS = 86_400 * 7; // 7 days — WhatsApp 24h limit, but keep context longer

// ─── Sales Agent ─────────────────────────────────────────────────────────────

export class SalesAgent {
  private readonly vertexAI: VertexAI;
  private readonly fsm: ConversationFsm;
  private readonly ragRetriever: KnowledgeBaseRetriever;

  constructor(
    private readonly projectId: string,
    private readonly location: string,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.vertexAI = new VertexAI({ project: projectId, location });
    this.fsm = new ConversationFsm();
    this.ragRetriever = new KnowledgeBaseRetriever(projectId, location, redis, logger);
  }

  /**
   * Process one inbound message from any channel.
   * This is the primary entry point called by all channel adapters.
   */
  async processMessage(
    inbound: AgentMessage,
    agentConfig: TenantAgentConfig
  ): Promise<ProcessMessageResult> {
    const timer = this.logger.startTimer();

    // 1. Load or initialize conversation context
    const context = await this.loadOrCreateContext(
      inbound.conversationId,
      agentConfig.tenantId,
      inbound.channel,
      inbound.externalUserId
    );

    // 2. NLU — fast Gemini Flash pass to extract structured info
    const nlu = await this.runNlu(inbound.content, context, agentConfig);

    // 3. RAG — retrieve grounding knowledge
    const ragResult = await this.ragRetriever.retrieve(
      agentConfig.tenantId,
      inbound.content,
      5,
      0.78 // Slightly lower threshold than playbook to increase recall
    );

    // 4. FSM transition
    const fsmInput: FsmInput = {
      userMessage: inbound.content,
      confidenceScore: nlu.confidenceScore,
      sentimentScore: nlu.sentimentScore,
      requestedHuman: containsEscalationKeyword(inbound.content),
      bookingIntentDetected: nlu.hasBookingIntent,
      objectionDetected: nlu.hasObjection,
      extractedEntities: nlu.entities,
      hasGrounding: ragResult.chunks.length > 0,
    };

    const fsmOutput = this.fsm.transition(context, fsmInput);

    // 5. Generate response with Gemini Pro
    const groundingContext = this.ragRetriever.buildGroundingContext(ragResult.chunks);
    const systemPrompt = this.buildSystemPrompt(agentConfig, groundingContext, fsmOutput.stateInstructions);
    const conversationHistory = await this.loadConversationHistory(inbound.conversationId, 10);

    const outboundMessage = await this.generateResponse(
      systemPrompt,
      conversationHistory,
      inbound.content,
      agentConfig
    );

    // 6. Handle lead creation on first qualification
    let leadCreated = false;
    let leadId = fsmOutput.context.leadId;

    if (!leadId && this.isQualificationComplete(fsmOutput.context.capturedData)) {
      leadId = await this.createCrmLead(fsmOutput.context, agentConfig, inbound.channel);
      leadCreated = true;
      fsmOutput.context.leadId = leadId;
    }

    // 7. Persist conversation turn and updated context
    await this.persistTurn(inbound, outboundMessage, fsmOutput.context, nlu, agentConfig.tenantId);
    await this.saveContext(inbound.conversationId, fsmOutput.context);

    // 8. Trigger side effects via Pub/Sub
    if (fsmOutput.triggerHandoff) {
      await publishEvent(TOPICS.CONVERSATION_HANDOFF_REQUESTED, {
        tenantId: agentConfig.tenantId,
        conversationId: inbound.conversationId,
        leadId,
        escalationReason: fsmOutput.escalationReason,
        channel: inbound.channel,
        humanHandoffEmail: agentConfig.humanHandoffEmail,
        capturedData: fsmOutput.context.capturedData,
      });
    }

    if (leadCreated && leadId) {
      await publishEvent(TOPICS.LEAD_CREATED, {
        tenantId: agentConfig.tenantId,
        leadId,
        source: `ai_agent_${inbound.channel}`,
      });
    }

    timer({
      conversationId: inbound.conversationId,
      state: fsmOutput.nextState,
      ragChunks: ragResult.chunks.length,
      nluConfidence: nlu.confidenceScore,
    });

    return {
      outboundMessage,
      conversationId: inbound.conversationId,
      state: fsmOutput.nextState,
      triggerHandoff: fsmOutput.triggerHandoff,
      triggerBooking: fsmOutput.triggerBooking,
      escalationReason: fsmOutput.escalationReason,
      leadCreated,
      leadId,
    };
  }

  /**
   * NLU pass using Gemini Flash — cheaper and faster than Pro for extraction tasks.
   * Returns structured JSON; we prompt the model to respond ONLY with valid JSON.
   */
  private async runNlu(
    message: string,
    context: ConversationContext,
    config: TenantAgentConfig
  ): Promise<NluResult> {
    const model = this.vertexAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    });

    const prompt = `Analyze this message from a sales conversation and extract structured information.
Context: User is chatting with "${config.agentName}" from "${config.businessName}".
Current conversation state: ${context.state}
Already captured: ${JSON.stringify(context.capturedData)}

Message: "${message}"

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "intent": "question|objection|booking_request|provide_info|greeting|complaint|off_topic",
  "sentimentScore": <float -1.0 to 1.0>,
  "entities": {
    "name": <string or null>,
    "email": <string or null>,
    "phone": <string or null>,
    "company": <string or null>,
    "budget": <string or null>,
    "timeline": <string or null>,
    "useCase": <string or null>
  },
  "hasObjection": <boolean>,
  "hasBookingIntent": <boolean>,
  "confidenceScore": <float 0.0 to 1.0 — how confident are you in this classification>
}`;

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.candidates?.[0]?.content.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text) as NluResult;

      // Validate and sanitize
      return {
        intent: parsed.intent ?? 'off_topic',
        sentimentScore: Math.max(-1, Math.min(1, parsed.sentimentScore ?? 0)),
        entities: this.sanitizeEntities(parsed.entities ?? {}),
        hasObjection: parsed.hasObjection ?? false,
        hasBookingIntent: parsed.hasBookingIntent ?? containsBookingKeyword(message),
        confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore ?? 0.5)),
      };
    } catch (err) {
      this.logger.warn('NLU parse failed, using fallback', { error: err });
      return {
        intent: 'off_topic',
        sentimentScore: 0,
        entities: {},
        hasObjection: false,
        hasBookingIntent: containsBookingKeyword(message),
        confidenceScore: 0.5,
      };
    }
  }

  /**
   * Build the system prompt combining: agent persona, knowledge base, state instructions.
   * This is sent to Gemini Pro on every turn.
   */
  private buildSystemPrompt(
    config: TenantAgentConfig,
    groundingContext: string,
    stateInstructions: string
  ): string {
    return `You are ${config.agentName}, a sales assistant for ${config.businessName}.

IDENTITY RULES:
- You are ${config.agentName}. Never reveal you are an AI, Claude, or any underlying technology.
- If asked what technology you use, say you're the ${config.businessName} assistant.
- Always maintain a warm, professional, helpful tone.
- Respond in ${config.languageCode === 'auto' ? 'the same language the user is writing in' : config.languageCode}.
- Keep responses concise — 2-4 sentences for most turns. This is a chat, not an email.

${config.agentPersona}

${groundingContext}

CRITICAL INSTRUCTIONS:
- NEVER invent product details, pricing, or features not in the knowledge base above.
- If you don't know the answer, say "Great question — let me connect you with a specialist who can give you the exact details."
- Do not quote competitor comparisons unless explicitly in the knowledge base.
- Do not make guarantees or promises about pricing, delivery, or availability.

CURRENT FOCUS:
${stateInstructions}

FORMAT:
- Use plain text only. No markdown, no lists, no bold/italic.
- If presenting time slots, use natural language: "I have availability Thursday at 2pm or Friday at 10am."`;
  }

  /**
   * Generate the response using Gemini 1.5 Pro.
   * We pass the full conversation history as turns for continuity.
   */
  private async generateResponse(
    systemPrompt: string,
    history: Array<{ role: 'user' | 'model'; content: string }>,
    currentMessage: string,
    config: TenantAgentConfig
  ): Promise<string> {
    const model = this.vertexAI.getGenerativeModel({
      model: 'gemini-1.5-pro',
      systemInstruction: systemPrompt,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512,
        topP: 0.95,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      ],
    });

    const chat = model.startChat({
      history: history.map(h => ({
        role: h.role,
        parts: [{ text: h.content }],
      })),
    });

    const result = await chat.sendMessage(currentMessage);
    const text = result.response.candidates?.[0]?.content.parts?.[0]?.text;

    if (!text) {
      this.logger.warn('Gemini returned empty response, using fallback');
      return `Thanks for your message! Let me get you the best answer. Could you give me just a moment?`;
    }

    return text.trim();
  }

  // ─── Context Storage ─────────────────────────────────────────────────────

  private async loadOrCreateContext(
    conversationId: string,
    tenantId: TenantId,
    channel: ConversationChannel,
    externalUserId: string
  ): Promise<ConversationContext> {
    const key = `conv:ctx:${conversationId}`;
    const raw = await this.redis.get(key);

    if (raw) {
      return JSON.parse(raw) as ConversationContext;
    }

    return createConversationContext(conversationId, tenantId, channel, externalUserId);
  }

  private async saveContext(conversationId: string, context: ConversationContext): Promise<void> {
    await this.redis.setex(
      `conv:ctx:${conversationId}`,
      CONTEXT_TTL_SECONDS,
      JSON.stringify(context)
    );
  }

  private async loadConversationHistory(
    conversationId: string,
    lastN: number
  ): Promise<Array<{ role: 'user' | 'model'; content: string }>> {
    const key = `conv:history:${conversationId}`;
    const raw = await this.redis.lrange(key, -lastN * 2, -1);

    const history: Array<{ role: 'user' | 'model'; content: string }> = [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      history.push({ role: 'user', content: raw[i] ?? '' });
      history.push({ role: 'model', content: raw[i + 1] ?? '' });
    }
    return history;
  }

  // ─── CRM Integration ──────────────────────────────────────────────────────

  private isQualificationComplete(
    data: ConversationContext['capturedData']
  ): boolean {
    return !!(data.name && (data.email || data.phone));
  }

  private async createCrmLead(
    context: ConversationContext,
    config: TenantAgentConfig,
    channel: ConversationChannel
  ): Promise<string> {
    const client = await getTenantClient(context.tenantId);
    try {
      const leadId = randomUUID();
      await client.query(
        `INSERT INTO leads
           (id, tenant_id, first_name, last_name, email, phone, company_name,
            source, status, assigned_user_id, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new', NULL, $9, NOW(), NOW())`,
        [
          leadId,
          context.tenantId,
          (context.capturedData.name ?? '').split(' ')[0] ?? '',
          (context.capturedData.name ?? '').split(' ').slice(1).join(' ') || null,
          context.capturedData.email,
          context.capturedData.phone,
          context.capturedData.company,
          `ai_agent_${channel}`,
          `Captured via ${channel} AI agent. Budget: ${context.capturedData.budget ?? 'unknown'}. Use case: ${context.capturedData.useCase ?? 'unknown'}.`,
        ]
      );

      // Link the conversation to the lead
      await client.query(
        `UPDATE conversations SET lead_id = $1 WHERE id = $2`,
        [leadId, context.conversationId]
      );

      this.logger.info('Lead created from AI agent conversation', {
        leadId,
        conversationId: context.conversationId,
        channel,
      });

      return leadId;
    } finally {
      client.release();
    }
  }

  private async persistTurn(
    inbound: AgentMessage,
    outbound: string,
    context: ConversationContext,
    nlu: NluResult,
    tenantId: TenantId
  ): Promise<void> {
    // Push to Redis history list for fast context loading
    const historyKey = `conv:history:${inbound.conversationId}`;
    await this.redis.rpush(historyKey, inbound.content, outbound);
    await this.redis.expire(historyKey, CONTEXT_TTL_SECONDS);

    // Write to PostgreSQL for permanent audit trail and CRM UI
    const client = await getTenantClient(tenantId);
    try {
      // Ensure conversation record exists
      await client.query(
        `INSERT INTO conversations
           (id, tenant_id, channel, external_user_id, state, lead_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           state = $5,
           lead_id = COALESCE(conversations.lead_id, $6),
           updated_at = NOW()`,
        [
          inbound.conversationId,
          tenantId,
          inbound.channel,
          inbound.externalUserId,
          context.state,
          context.leadId,
        ]
      );

      // Insert inbound turn
      await client.query(
        `INSERT INTO conversation_turns
           (id, conversation_id, tenant_id, direction, content, sentiment_score,
            intent, confidence_score, fsm_state, created_at)
         VALUES ($1, $2, $3, 'inbound', $4, $5, $6, $7, $8, NOW())`,
        [
          randomUUID(),
          inbound.conversationId,
          tenantId,
          inbound.content,
          nlu.sentimentScore,
          nlu.intent,
          nlu.confidenceScore,
          context.state,
        ]
      );

      // Insert outbound turn
      await client.query(
        `INSERT INTO conversation_turns
           (id, conversation_id, tenant_id, direction, content, fsm_state, created_at)
         VALUES ($1, $2, $3, 'outbound', $4, $5, NOW())`,
        [randomUUID(), inbound.conversationId, tenantId, outbound, context.state]
      );
    } finally {
      client.release();
    }
  }

  private sanitizeEntities(
    entities: Partial<ConversationContext['capturedData']>
  ): Partial<ConversationContext['capturedData']> {
    // Basic sanitization — strip control chars, limit lengths
    const result: Partial<ConversationContext['capturedData']> = {};
    for (const [key, value] of Object.entries(entities)) {
      if (typeof value === 'string' && value.length > 0) {
        result[key as keyof typeof result] = value
          .replace(/[\x00-\x1F\x7F]/g, '')
          .slice(0, 200) as never;
      }
    }
    return result;
  }
}
