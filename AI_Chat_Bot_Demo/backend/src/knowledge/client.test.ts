import { describe, expect, it, vi } from "vitest";
import axios from "axios";
import { buildKnowledgeSearchPayload, searchKnowledgeWithMeta } from "./client";
import { getKnowledgeRetrievalParams } from "./knowledgeRetrievalProfiles";

vi.mock("axios", () => {
  const post = vi.fn();
  const create = vi.fn(() => ({
    post: vi.fn(),
    get: vi.fn(),
    delete: vi.fn()
  }));
  return {
    default: { post, create },
    post,
    create
  };
});

describe("buildKnowledgeSearchPayload", () => {
  it("defaults limit when no retrieval params provided", () => {
    const payload = buildKnowledgeSearchPayload({
      clientId: "c1",
      query: "hello",
      domain: "example.com"
    });
    expect(payload).toMatchObject({
      clientId: "c1",
      query: "hello",
      domainInput: "example.com",
      limit: 5
    });
  });

  it("does not inject limit when retrieval params are present", () => {
    const payload = buildKnowledgeSearchPayload({
      clientId: "c1",
      query: "hello",
      domain: "example.com",
      ...getKnowledgeRetrievalParams("balanced")
    });
    expect(payload).not.toHaveProperty("limit");
    expect(payload).toMatchObject({
      clientId: "c1",
      query: "hello",
      strategy: "hybrid",
      candidateLimit: 30,
      domainInput: "example.com"
    });
  });

  it("keeps explicit limit even when retrieval params are present", () => {
    const payload = buildKnowledgeSearchPayload({
      clientId: "c1",
      query: "hello",
      domain: "example.com",
      limit: 3,
      ...getKnowledgeRetrievalParams("balanced")
    });
    expect(payload).toMatchObject({
      clientId: "c1",
      query: "hello",
      limit: 3,
      strategy: "hybrid",
      domainInput: "example.com"
    });
  });

  it("propagates retrieval metadata from knowledge backend", async () => {
    const mockPost = (axios as any).post as ReturnType<typeof vi.fn>;
    mockPost.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: "r1",
            clientId: "c1",
            domain: "example.com",
            url: "https://example.com",
            chunkIndex: 0,
            text: "hello",
            score: 0.9,
            createdAt: new Date().toISOString()
          }
        ],
        retrievalStatus: "ok",
        noAnswerRecommended: false,
        confidence: { level: "high", score: 0.9 }
      }
    });

    const response = await searchKnowledgeWithMeta({
      clientId: "c1",
      query: "hello",
      domain: "example.com"
    });

    expect(response.results.length).toBe(1);
    expect(response.retrievalStatus).toBe("ok");
    expect(response.noAnswerRecommended).toBe(false);
    expect(response.confidence?.level).toBe("high");
  });
});
