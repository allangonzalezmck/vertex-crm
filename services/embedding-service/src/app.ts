/**
 * Vertex CRM — Embedding Service
 * Knowledge base ingestion pipeline:
 *   PDF / DOCX / CSV / plain text → chunk → embed (Vertex AI text-embedding-004)
 *                                          → upsert to Vector Search index
 *   URL → Playwright scrape → same pipeline
 *   YouTube → transcript via yt-dlp → same pipeline
 *
 * All vectors tagged with { tenant_id, document_id, chunk_index }
 * for per-tenant retrieval in the AI Sales Agent.
 */

import Fastify from 'fastify';
import { Storage } from '@google-cloud/storage';
import { PredictionServiceClient } from '@google-cloud/aiplatform';
import { Pool } from 'pg';
import { createLogger } from '../../../shared/src/utils/logger';
import { publishEvent, TOPICS } from '../../../shared/src/utils/pubsub';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const logger = createLogger('embedding-service');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new Storage();
const BUCKET = process.env.GCS_KB_BUCKET!;

const predClient = new PredictionServiceClient({ apiEndpoint: `${process.env.GCP_REGION}-aiplatform.googleapis.com` });
const EMBEDDING_MODEL = `projects/${process.env.GCP_PROJECT}/locations/${process.env.GCP_REGION}/publishers/google/models/text-embedding-004`;
const VECTOR_SEARCH_INDEX = process.env.VERTEX_VECTOR_SEARCH_INDEX!;
const VECTOR_SEARCH_ENDPOINT = process.env.VERTEX_VECTOR_SEARCH_ENDPOINT!;

const CHUNK_SIZE   = 512;   // tokens (approx 400 chars)
const CHUNK_OVERLAP = 64;

// ── Text chunking ─────────────────────────────────────────────────────────────
function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  // Simple word-boundary chunking (token proxy: 1 token ≈ 0.75 words)
  const words = text.split(/\s+/).filter(Boolean);
  const wordChunkSize  = Math.round(size  * 0.75);
  const wordChunkOverlap = Math.round(overlap * 0.75);

  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + wordChunkSize).join(' '));
    i += wordChunkSize - wordChunkOverlap;
  }
  return chunks.filter((c) => c.trim().length > 30); // drop tiny chunks
}

// ── Embedding via Vertex AI ───────────────────────────────────────────────────
async function embedChunks(chunks: string[]): Promise<number[][]> {
  const BATCH = 5; // text-embedding-004: max 5 texts per request
  const vectors: number[][] = [];

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const [response] = await predClient.predict({
      endpoint: EMBEDDING_MODEL,
      instances: batch.map((text) => ({ content: text })),
      parameters: { outputDimensionality: 768 },
    });
    for (const pred of response.predictions ?? []) {
      const vals = (pred.structValue?.fields?.embeddings?.structValue?.fields?.values?.listValue?.values ?? [])
        .map((v: any) => v.numberValue as number);
      vectors.push(vals);
    }
  }
  return vectors;
}

// ── Upsert to Vector Search ───────────────────────────────────────────────────
async function upsertVectors(
  tenantId: string,
  documentId: string,
  chunks: string[],
  vectors: number[][]
): Promise<void> {
  // Vector Search batch upsert via streaming
  const datapoints = vectors.map((embedding, idx) => ({
    datapointId: `${tenantId}:${documentId}:${idx}`,
    featureVector: embedding,
    restricts: [
      { namespace: 'tenant_id', allowList: [tenantId] },
      { namespace: 'document_id', allowList: [documentId] },
    ],
    crowdingTag: { crowdingAttribute: tenantId },
  }));

  // Batch in groups of 100 (VS limit)
  for (let i = 0; i < datapoints.length; i += 100) {
    await predClient.upsertDatapoints({
      index: VECTOR_SEARCH_INDEX,
      datapoints: datapoints.slice(i, i + 100),
    } as any);
  }

  logger.info({ tenantId, documentId, count: datapoints.length }, 'Vectors upserted');
}

// ── Document extractors ───────────────────────────────────────────────────────
async function extractFromGCS(gcsUri: string, mimeType: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertex-kb-'));
  const localPath = path.join(tmpDir, 'doc');

  const [bucket, ...pathParts] = gcsUri.replace('gs://', '').split('/');
  const file = storage.bucket(bucket).file(pathParts.join('/'));
  await file.download({ destination: localPath });

  let text = '';
  if (mimeType === 'application/pdf') {
    text = execSync(`pdftotext -layout "${localPath}" -`, { maxBuffer: 50_000_000 }).toString();
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    text = execSync(`docx2txt "${localPath}" -`, { maxBuffer: 50_000_000 }).toString();
  } else if (mimeType === 'text/csv') {
    const raw = await fs.readFile(localPath, 'utf8');
    // Convert CSV to readable prose (headers + row summaries)
    const lines = raw.split('\n').filter(Boolean);
    const headers = lines[0].split(',');
    text = lines.slice(1, 200).map((row) => {
      const vals = row.split(',');
      return headers.map((h, i) => `${h}: ${vals[i] ?? ''}`).join(', ');
    }).join('\n');
  } else {
    text = await fs.readFile(localPath, 'utf8');
  }

  await fs.rm(tmpDir, { recursive: true });
  return text;
}

async function extractFromUrl(url: string): Promise<string> {
  // Playwright scrape (headless Chromium installed in Docker image)
  const script = `
    const { chromium } = require('playwright-core');
    (async () => {
      const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const text = await page.evaluate(() => document.body.innerText);
      process.stdout.write(text); // captured by execSync in parent process
      await browser.close();
    })();
  `;
  const tmpFile = path.join(os.tmpdir(), `scrape-${randomUUID()}.js`);
  await fs.writeFile(tmpFile, script);
  const text = execSync(`node "${tmpFile}"`, { maxBuffer: 10_000_000, timeout: 45_000 }).toString();
  await fs.unlink(tmpFile);
  return text;
}

async function extractFromYoutube(url: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertex-yt-'));
  execSync(
    `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "${tmpDir}/transcript" "${url}"`,
    { timeout: 60_000 }
  );
  const files = await fs.readdir(tmpDir);
  const vttFile = files.find((f) => f.endsWith('.vtt'));
  if (!vttFile) throw new Error('No transcript found for YouTube video');

  const vtt = await fs.readFile(path.join(tmpDir, vttFile), 'utf8');
  // Strip VTT markup
  const text = vtt
    .split('\n')
    .filter((l) => !l.startsWith('WEBVTT') && !l.match(/^\d{2}:/) && !l.match(/^NOTE/) && l.trim())
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  await fs.rm(tmpDir, { recursive: true });
  return text;
}

// ── Core ingest pipeline ──────────────────────────────────────────────────────
async function ingestDocument(documentId: string): Promise<void> {
  const { rows } = await pool.query(
    'SELECT * FROM kb_documents WHERE id = $1',
    [documentId]
  );
  const doc = rows[0];
  if (!doc) throw new Error(`Document ${documentId} not found`);

  logger.info({ documentId, sourceType: doc.source_type }, 'Starting ingestion');

  await pool.query(
    `UPDATE kb_documents SET status = 'processing', processing_started_at = now() WHERE id = $1`,
    [documentId]
  );

  let rawText = '';

  try {
    switch (doc.source_type) {
      case 'file':
        rawText = await extractFromGCS(doc.gcs_uri, doc.mime_type);
        break;
      case 'url':
        rawText = await extractFromUrl(doc.source_url);
        break;
      case 'youtube':
        rawText = await extractFromYoutube(doc.source_url);
        break;
      default:
        throw new Error(`Unknown source_type: ${doc.source_type}`);
    }

    if (!rawText || rawText.trim().length < 50) {
      throw new Error('Extracted text too short or empty');
    }

    const chunks  = chunkText(rawText);
    const vectors = await embedChunks(chunks);
    await upsertVectors(doc.tenant_id, documentId, chunks, vectors);

    // Store chunk metadata in DB for retrieval context
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM kb_document_chunks WHERE document_id = $1',
        [documentId]
      );
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO kb_document_chunks (id, document_id, tenant_id, chunk_index, content, token_count)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), documentId, doc.tenant_id, i, chunks[i], Math.round(chunks[i].length / 3)]
        );
      }
      await client.query(
        `UPDATE kb_documents SET status = 'ready', chunk_count = $1, processed_at = now() WHERE id = $2`,
        [chunks.length, documentId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await publishEvent(TOPICS.KB_DOCUMENT_READY, {
      tenantId: doc.tenant_id,
      documentId,
      chunkCount: chunks.length,
    });

    logger.info({ documentId, chunkCount: chunks.length }, 'Ingestion complete');
  } catch (err) {
    logger.error({ err, documentId }, 'Ingestion failed');
    await pool.query(
      `UPDATE kb_documents SET status = 'failed', error_message = $1 WHERE id = $2`,
      [(err as Error).message, documentId]
    );
    throw err;
  }
}

// ── Fastify app ───────────────────────────────────────────────────────────────
const fastify = Fastify({ logger: false });

fastify.get('/health', async () => ({ status: 'ok', service: 'embedding-service' }));
fastify.get('/ready', async () => {
  await pool.query('SELECT 1');
  return { status: 'ready' };
});

// POST /kb/ingest — trigger ingestion (called after file upload to GCS)
fastify.post<{
  Body: {
    tenantId: string;
    name: string;
    sourceType: 'file' | 'url' | 'youtube';
    gcsUri?: string;
    sourceUrl?: string;
    mimeType?: string;
  };
}>('/kb/ingest', async (req, reply) => {
  const { tenantId, name, sourceType, gcsUri, sourceUrl, mimeType } = req.body;

  const documentId = randomUUID();
  await pool.query(
    `INSERT INTO kb_documents
       (id, tenant_id, name, source_type, gcs_uri, source_url, mime_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [documentId, tenantId, name, sourceType, gcsUri ?? null, sourceUrl ?? null, mimeType ?? 'text/plain']
  );

  // Kick off ingestion asynchronously
  ingestDocument(documentId).catch((err) =>
    logger.error({ err, documentId }, 'Background ingestion error')
  );

  return reply.status(202).send({ documentId, status: 'processing' });
});

// GET /kb/documents — list tenant KB docs
fastify.get<{ Querystring: { tenantId: string; page?: number } }>(
  '/kb/documents',
  async (req) => {
    const { tenantId, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT id, name, source_type, status, chunk_count, processed_at, created_at
       FROM kb_documents
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset]
    );
    const { rows: [{ total }] } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM kb_documents WHERE tenant_id = $1 AND deleted_at IS NULL',
      [tenantId]
    );

    return { documents: rows, total, page, limit };
  }
);

// GET /kb/documents/:id — document status
fastify.get<{ Params: { id: string } }>('/kb/documents/:id', async (req, reply) => {
  const { rows } = await pool.query(
    'SELECT id, name, source_type, status, chunk_count, error_message, processed_at FROM kb_documents WHERE id = $1',
    [req.params.id]
  );
  if (!rows.length) return reply.status(404).send({ error: 'Not found' });
  return rows[0];
});

// DELETE /kb/documents/:id — remove doc + vectors
fastify.delete<{ Params: { id: string } }>('/kb/documents/:id', async (req, reply) => {
  const { rows } = await pool.query(
    'UPDATE kb_documents SET deleted_at = now() WHERE id = $1 RETURNING tenant_id',
    [req.params.id]
  );
  if (!rows.length) return reply.status(404).send({ error: 'Not found' });

  // Delete chunk metadata (vectors are cleaned up by a scheduled job)
  await pool.query('DELETE FROM kb_document_chunks WHERE document_id = $1', [req.params.id]);

  logger.info({ documentId: req.params.id }, 'Document deleted');
  return reply.status(204).send();
});

// POST /kb/pubsub — GCS object finalize trigger (auto-ingest on upload)
fastify.post<{ Body: { message: { data: string } } }>('/kb/pubsub', async (req, reply) => {
  const payload = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString());
  logger.info({ payload }, 'GCS trigger received');

  if (payload.documentId) {
    ingestDocument(payload.documentId).catch((err) =>
      logger.error({ err, payload }, 'Pub/Sub triggered ingestion error')
    );
  }
  return reply.status(204).send();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({ port: 8080, host: '0.0.0.0' });
    logger.info('embedding-service listening on :8080');
  } catch (err) {
    logger.error({ err }, 'Failed to start embedding-service');
    process.exit(1);
  }
};

start();
