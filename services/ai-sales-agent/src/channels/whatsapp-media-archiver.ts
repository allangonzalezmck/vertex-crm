/**
 * Vertex CRM — WhatsApp Media Archiver (GAP-02 fix)
 *
 * WHY: Meta hosts WhatsApp media for only ~30 days. Previously the adapter
 * skipped image/audio/video/document messages entirely, so attachments a
 * lead sent (e.g., a photo of a referral coupon, a voice note) were lost.
 * This module downloads each media item at receipt time and archives it in
 * the tenant's GCS bucket — permanent, tenant-scoped, backup-covered.
 *
 * Meta media retrieval is a 2-step dance:
 *   1. GET /{media-id}            → { url, mime_type }   (url is short-lived)
 *   2. GET {url} w/ Bearer token  → binary
 *
 * File location: services/ai-sales-agent/src/channels/whatsapp-media-archiver.ts
 */

import { Storage } from '@google-cloud/storage';
import { createLogger, Logger } from '../../../../shared/src/utils/logger.js';

export interface InboundMedia {
  /** Meta media ID from the webhook payload */
  id: string;
  kind: 'image' | 'audio' | 'video' | 'document';
  mimeType?: string;
  caption?: string;
  filename?: string;
}

export interface ArchivedMedia {
  gcsPath: string;   // gs://bucket/whatsapp-media/{tenantId}/{conversationId}/{mediaId}.{ext}
  mimeType: string;
  sizeBytes: number;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // WhatsApp caps most media well below this

export class WhatsAppMediaArchiver {
  private readonly logger: Logger;
  private readonly storage: Storage;
  private readonly graphBase = 'https://graph.facebook.com/v19.0';

  constructor(
    private readonly accessToken: string,
    private readonly bucketName: string = process.env.WHATSAPP_MEDIA_BUCKET ??
      `${process.env.GCP_PROJECT_ID}-whatsapp-media`
  ) {
    this.logger = createLogger('whatsapp-media-archiver');
    this.storage = new Storage();
  }

  /**
   * Download one media item from Meta and archive it to GCS.
   * Never throws to the caller's hot path philosophy: on failure it logs and
   * returns null so the text turn still persists (media is best-effort,
   * conversation continuity is not).
   */
  async archive(
    media: InboundMedia,
    tenantId: string,
    conversationId: string
  ): Promise<ArchivedMedia | null> {
    try {
      // Step 1: resolve the short-lived download URL
      const metaRes = await fetch(`${this.graphBase}/${media.id}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      const meta = (await metaRes.json()) as {
        url?: string; mime_type?: string; file_size?: number;
        error?: { message: string; code: number };
      };
      if (!metaRes.ok || meta.error || !meta.url) {
        this.logger.warn('Media metadata fetch failed', {
          mediaId: media.id, error: meta.error?.message ?? metaRes.statusText,
        });
        return null;
      }
      if ((meta.file_size ?? 0) > MAX_MEDIA_BYTES) {
        this.logger.warn('Media exceeds size cap, skipping archive', {
          mediaId: media.id, size: meta.file_size,
        });
        return null;
      }

      // Step 2: download the binary (same Bearer token required)
      const binRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!binRes.ok) {
        this.logger.warn('Media binary download failed', { mediaId: media.id, status: binRes.status });
        return null;
      }
      const buffer = Buffer.from(await binRes.arrayBuffer());

      // Step 3: archive to the tenant's namespace in GCS
      const mimeType = meta.mime_type ?? media.mimeType ?? 'application/octet-stream';
      const ext = EXT_BY_MIME[mimeType] ?? 'bin';
      // conversationId contains ':' (wa:{phone}:{from}) — safe for GCS object names
      const objectPath = `whatsapp-media/${tenantId}/${conversationId}/${media.id}.${ext}`;

      await this.storage.bucket(this.bucketName).file(objectPath).save(buffer, {
        contentType: mimeType,
        resumable: false,
        metadata: {
          metadata: {
            tenantId,
            conversationId,
            waMediaId: media.id,
            kind: media.kind,
            originalFilename: media.filename ?? '',
          },
        },
      });

      const gcsPath = `gs://${this.bucketName}/${objectPath}`;
      this.logger.info('Media archived', { gcsPath, sizeBytes: buffer.length });
      return { gcsPath, mimeType, sizeBytes: buffer.length };
    } catch (err) {
      this.logger.error('Media archive error (turn will persist without media)', err as Error, {
        mediaId: media.id, tenantId,
      });
      return null;
    }
  }
}
