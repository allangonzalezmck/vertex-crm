/**
 * @file services/ai-sales-agent/src/booking/cal-booking.service.ts
 * @description Cal.com API integration for scheduling discovery/sales calls.
 * Uses Cal.com v2 API with API key authentication.
 *
 * Architecture note: We chose Cal.com over Calendly because:
 * 1. Self-hostable (important for enterprise tenants with data residency requirements)
 * 2. Open source — we can extend it if needed
 * 3. Better API (REST, proper webhooks, no artificial rate limits)
 * Calendly is supported as a future adapter via the same BookingService interface.
 */

import type { TenantId } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';
import { getTenantClient } from '../../../../shared/src/utils/database.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AvailableSlot {
  startTime: string; // ISO 8601
  endTime: string;
  eventTypeId: number;
  calLink: string;
}

export interface BookingPayload {
  eventTypeId: number;
  start: string;
  attendee: {
    name: string;
    email: string;
    timeZone: string;
  };
  metadata?: Record<string, string>;
  responses?: Record<string, string>;
}

export interface CalBooking {
  uid: string;
  startTime: string;
  endTime: string;
  status: 'ACCEPTED' | 'PENDING' | 'CANCELLED' | 'REJECTED';
  attendees: Array<{ email: string; name: string }>;
  organizer: { email: string; name: string };
  meetingUrl: string | null;
  calLink: string;
}

export interface CalBookingWebhookPayload {
  uid: string;
  startTime: string;
  attendees: Array<{ email: string; name: string }>;
  organizer: { email: string };
}

// ─── Cal.com Booking Service ─────────────────────────────────────────────────

export class CalBookingService {
  private readonly apiBase = 'https://api.cal.com/v2';

  constructor(private readonly logger: Logger) {}

  /**
   * Fetch available time slots from Cal.com for the next 7 days.
   * Returns up to 5 slots for the agent to present to the user.
   */
  async getAvailableSlots(
    calLink: string,
    days: number = 7,
    apiKey?: string
  ): Promise<AvailableSlot[]> {
    const eventTypeId = await this.resolveEventTypeId(calLink, apiKey);
    if (!eventTypeId) return [];

    const startTime = new Date().toISOString();
    const endTime = new Date(Date.now() + days * 86_400_000).toISOString();

    const params = new URLSearchParams({
      eventTypeId: String(eventTypeId),
      startTime,
      endTime,
    });

    const response = await fetch(`${this.apiBase}/slots/available?${params}`, {
      headers: this.buildHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      this.logger.warn('Cal.com slot fetch failed', { status: response.status, calLink });
      return [];
    }

    const data = await response.json() as {
      data: {
        slots: Record<string, Array<{ time: string }>>;
      };
    };

    const slots: AvailableSlot[] = [];
    for (const [date, daySlots] of Object.entries(data.data.slots)) {
      for (const slot of daySlots.slice(0, 2)) { // Max 2 per day
        slots.push({
          startTime: slot.time,
          endTime: new Date(new Date(slot.time).getTime() + 30 * 60_000).toISOString(),
          eventTypeId,
          calLink,
        });
        if (slots.length >= 5) break;
      }
      if (slots.length >= 5) break;
    }

    return slots;
  }

  /**
   * Create a booking in Cal.com on behalf of a lead.
   * Called when the user confirms a time slot during BOOK_CALL state.
   */
  async createBooking(
    payload: BookingPayload,
    apiKey?: string
  ): Promise<CalBooking> {
    const response = await fetch(`${this.apiBase}/bookings`, {
      method: 'POST',
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cal.com booking failed: ${response.status} ${error}`);
    }

    const data = await response.json() as { data: CalBooking };
    return data.data;
  }

  /**
   * Handle Cal.com webhook for BOOKING_CREATED events.
   * Updates the conversation context and CRM lead with booking details.
   */
  async handleBookingCreated(
    tenantId: TenantId,
    payload: CalBookingWebhookPayload
  ): Promise<void> {
    const attendee = payload.attendees[0];
    if (!attendee) return;

    const client = await getTenantClient(tenantId);
    try {
      // Find the conversation/lead by attendee email
      const result = await client.query(
        `SELECT c.id as conversation_id, l.id as lead_id
         FROM conversations c
         JOIN leads l ON l.id = c.lead_id
         WHERE l.tenant_id = $1 AND l.email = $2
         ORDER BY c.created_at DESC
         LIMIT 1`,
        [tenantId, attendee.email]
      );

      if (result.rows.length === 0) {
        this.logger.warn('No conversation found for Cal.com booking', {
          email: attendee.email,
          bookingUid: payload.uid,
        });
        return;
      }

      const { conversation_id, lead_id } = result.rows[0]!;

      // Update lead with booking details
      await client.query(
        `UPDATE leads SET
           status = 'qualified',
           next_activity_at = $1,
           notes = CONCAT(COALESCE(notes, ''), E'\n[AI Agent] Demo call booked for ', $1),
           updated_at = NOW()
         WHERE id = $2`,
        [payload.startTime, lead_id]
      );

      // Log activity
      await client.query(
        `INSERT INTO activities
           (id, tenant_id, lead_id, type, subject, description, scheduled_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'call', 'Discovery Call', $3, $4, NOW())`,
        [
          tenantId,
          lead_id,
          `Demo/discovery call booked via AI agent. Cal.com booking UID: ${payload.uid}`,
          payload.startTime,
        ]
      );

      this.logger.info('Cal.com booking synced to CRM', {
        tenantId,
        leadId: lead_id,
        conversationId: conversation_id,
        scheduledAt: payload.startTime,
      });
    } finally {
      client.release();
    }
  }

  /**
   * Format a slot time for display in chat messages.
   * "Thursday, Jan 16 at 2:00 PM" (user's apparent locale).
   */
  formatSlot(slot: AvailableSlot): string {
    const date = new Date(slot.startTime);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  private async resolveEventTypeId(
    calLink: string,
    apiKey?: string
  ): Promise<number | null> {
    // Cal.com links are like https://cal.com/username/event-type-slug
    // or https://cal.com/team/team-name/event-type-slug
    const parts = calLink.split('/').filter(Boolean);
    const slug = parts[parts.length - 1];

    if (!slug) return null;

    const response = await fetch(`${this.apiBase}/event-types?slug=${slug}`, {
      headers: this.buildHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      data: { eventTypes: Array<{ id: number; slug: string }> };
    };

    return data.data.eventTypes[0]?.id ?? null;
  }

  private buildHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'cal-api-version': '2024-08-13',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
  }
}
