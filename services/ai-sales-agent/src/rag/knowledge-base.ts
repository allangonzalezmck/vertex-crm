/**
 * @file services/ai-sales-agent/src/rag/knowledge-base.ts
 * @description RAG (Retrieval-Augmented Generation) pipeline for the AI Sales Agent.
 * Retrieves grounding context from Vertex AI Vector Search before every LLM call.
 *
 * Architecture note: We use Vertex AI Vector Search (ANN-based) over pgvector because:
 * 1. It scales to 100M+ vectors without impacting the transactional DB
 * 2. Sub-50ms latency at scale vs pgvector's ivfflat which degrades >1M rows
 * 3. Managed service — no index maintenance
 * Trade-off: Separate service to deploy, higher per-query cost vs pgvector at small scale.
 * Mitigation: Cache top-K results per (tenant, query_hash) in Redis with 5-min TTL.
 */

import { VertexAI } from '@google-cloud/vertexai';
import type { TenantId } from '../../../../shared/src/types/index.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';
import Redis from 'ioredis';
import { createHash } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KnowledgeChunk {
  chunkId: string;
  content: string;
  sourceTitle: string;
  sourceType: 'pdf' | 'docx' | 'url' | 'csv' | 'manual';
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalResult {
  chunks: KnowledgeChunk[];
  queryEmbedding: number[];
  cacheHit: boolean;
  latencyMs: number;
}

interface VectorSearchNeighbor {
  datapoint: {
    datapointId: string;
    crowdingTag?: { crowdingAttribute: string };
    restricts?: Array<{ namespace: string; allowList: string[] }>;
  };
  distance: number;
}

interface VectorSearchResponse {
  nearestNeighbors: Array<{
    id: string;
    neighbors: VectorSearchNeighbor[];
  }>;
}

// ─── Knowledge Base ──────────────────────────────────────────────────────────

export class KnowledgeBaseRetriever {
  private readonly vertexAI: VertexAI;
  private readonly embeddingModel: string = 'text-embedding-004';
  private readonly vectorSearchEndpoint: string;
  private readonly vectorSearchDeployedIndexId: string;

  constructor(
    private readonly projectId: string,
    private readonly location: string,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.vertexAI = new VertexAI({ project: projectId, location });
    this.vectorSearchEndpoint = process.env['VERTEX_VECTOR_SEARCH_ENDPOINT'] ?? '';
    this.vectorSearchDeployedIndexId = process.env['VERTEX_VECTOR_SEARCH_INDEX_ID'] ?? '';
  }

  /**
   * Retrieve the most relevant knowledge chunks for a given query.
   * Pipeline: query → embed → ANN search → fetch chunk content → return.
   *
   * The tenant filter ensures cross-tenant data isolation at the vector search level
   * using Vertex AI's restricts feature (namespace-based filtering).
   */
  async retrieve(
    tenantId: TenantId,
    query: string,
    topK: number = 5,
    similarityThreshold: number = 0.80
  ): Promise<RetrievalResult> {
    const start = Date.now();
    const cacheKey = `rag:${tenantId}:${createHash('sha256').update(query).digest('hex').slice(0, 16)}:k${topK}`;

    // Check Redis cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as RetrievalResult;
      return { ...parsed, cacheHit: true, latencyMs: Date.now() - start };
    }

    // Embed the query
    const embedding = await this.embedText(query);

    // Search Vertex AI Vector Search
    const neighbors = await this.searchVectors(tenantId, embedding, topK);

    // Filter by similarity threshold (Vector Search returns distance, not similarity)
    // For cosine distance: similarity = 1 - distance
    const relevantNeighbors = neighbors.filter(n => (1 - n.distance) >= similarityThreshold);

    // Fetch chunk content from storage (Redis cache or GCS/DB)
    const chunks = await this.fetchChunkContent(tenantId, relevantNeighbors);

    const result: RetrievalResult = {
      chunks,
      queryEmbedding: embedding,
      cacheHit: false,
      latencyMs: Date.now() - start,
    };

    // Cache for 5 minutes — knowledge bases don't change mid-conversation
    await this.redis.setex(cacheKey, 300, JSON.stringify(result));

    this.logger.info('RAG retrieval complete', {
      tenantId,
      queryLength: query.length,
      chunksFound: chunks.length,
      latencyMs: result.latencyMs,
    });

    return result;
  }

  /**
   * Embed text using Vertex AI text-embedding-004.
   * Returns 768-dimensional embedding vector.
   */
  async embedText(text: string): Promise<number[]> {
    const model = this.vertexAI.getGenerativeModel({ model: this.embeddingModel });

    // text-embedding-004 uses a different API surface than generative models
    const response = await fetch(
      `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${this.embeddingModel}:predict`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await this.getAccessToken()}`,
        },
        body: JSON.stringify({
          instances: [{ task_type: 'RETRIEVAL_QUERY', content: text.slice(0, 2048) }],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json() as {
      predictions: Array<{ embeddings: { values: number[] } }>;
    };

    return data.predictions[0]?.embeddings.values ?? [];
  }

  /**
   * Search Vertex AI Vector Search with tenant isolation via restricts.
   */
  private async searchVectors(
    tenantId: TenantId,
    embedding: number[],
    topK: number
  ): Promise<VectorSearchNeighbor[]> {
    const response = await fetch(
      `https://${this.vectorSearchEndpoint}/v1/projects/${this.projectId}/locations/${this.location}/indexEndpoints/${this.vectorSearchDeployedIndexId}:findNeighbors`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await this.getAccessToken()}`,
        },
        body: JSON.stringify({
          deployedIndexId: this.vectorSearchDeployedIndexId,
          queries: [{
            datapoint: {
              featureVector: embedding,
              // Tenant isolation: only return results tagged with this tenant's ID
              restricts: [{
                namespace: 'tenant_id',
                allowList: [tenantId],
              }],
            },
            neighborCount: topK,
            approximateNeighborCount: topK * 2,
          }],
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Vector Search error ${response.status}: ${body}`);
    }

    const data = await response.json() as VectorSearchResponse;
    return data.nearestNeighbors[0]?.neighbors ?? [];
  }

  /**
   * Fetch chunk content from Redis chunk store.
   * Chunks are stored as: `chunk:{tenantId}:{chunkId}` → JSON
   * They're written during KB ingestion by the embedding-service.
   */
  private async fetchChunkContent(
    tenantId: TenantId,
    neighbors: VectorSearchNeighbor[]
  ): Promise<KnowledgeChunk[]> {
    if (neighbors.length === 0) return [];

    const keys = neighbors.map(n => `chunk:${tenantId}:${n.datapoint.datapointId}`);
    const values = await this.redis.mget(...keys);

    const chunks: KnowledgeChunk[] = [];
    for (let i = 0; i < neighbors.length; i++) {
      const raw = values[i];
      const neighbor = neighbors[i]!;
      if (raw) {
        const chunk = JSON.parse(raw) as Omit<KnowledgeChunk, 'similarity'>;
        chunks.push({
          ...chunk,
          similarity: 1 - neighbor.distance,
        });
      }
    }

    // Sort by similarity descending
    return chunks.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Build a grounding prompt section from retrieved chunks.
   * Structured so the LLM clearly sees this is ground truth, not its training data.
   */
  buildGroundingContext(chunks: KnowledgeChunk[]): string {
    if (chunks.length === 0) {
      return 'No specific product information available for this query.';
    }

    const sections = chunks.map((chunk, i) =>
      `[Source ${i + 1}: ${chunk.sourceTitle}]\n${chunk.content}`
    );

    return [
      '=== VERIFIED PRODUCT KNOWLEDGE BASE ===',
      'Use ONLY the following information to answer product questions.',
      'Do not invent details not present below.',
      '',
      ...sections,
      '=== END KNOWLEDGE BASE ===',
    ].join('\n');
  }

  private async getAccessToken(): Promise<string> {
    // In Cloud Run, use the metadata server to get the service account token
    const response = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    const data = await response.json() as { access_token: string };
    return data.access_token;
  }
}
