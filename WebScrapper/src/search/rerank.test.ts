import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import { applyHeuristicRerank } from './rerank.js';

function makeResult(params: {
  id: string;
  url: string;
  text: string;
  score: number;
}): SearchResult {
  return {
    id: params.id,
    clientId: 'client-1',
    domain: 'example.com',
    url: params.url,
    sourceId: null,
    chunkIndex: 0,
    text: params.text,
    score: params.score,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

test('penalizes legal pages for non-legal queries', () => {
  const out = applyHeuristicRerank({
    query: 'dimmi i prezzi del furgone',
    results: [
      makeResult({
        id: 'legal',
        url: 'https://example.com/privacy-policy',
        text: 'Informativa privacy e cookie policy aziendale',
        score: 0.91,
      }),
      makeResult({
        id: 'pricing',
        url: 'https://example.com/faq-prezzi',
        text: 'Prezzi del furgone: acquisto 45000 euro, noleggio 25000 euro.',
        score: 0.86,
      }),
    ],
  });

  assert.equal(out.results[0]?.id, 'pricing');
});

test('does not penalize legal pages when query is legal/policy', () => {
  const out = applyHeuristicRerank({
    query: 'privacy policy cookie',
    results: [
      makeResult({
        id: 'legal',
        url: 'https://example.com/privacy-policy',
        text: 'Informativa privacy e cookie policy aziendale',
        score: 0.7,
      }),
      makeResult({
        id: 'generic',
        url: 'https://example.com/products',
        text: 'Catalogo prodotti e servizi',
        score: 0.72,
      }),
    ],
  });

  assert.equal(out.results[0]?.id, 'legal');
});

test('boosts contact-like chunks for contact queries', () => {
  const out = applyHeuristicRerank({
    query: 'contatti email e telefono',
    results: [
      makeResult({
        id: 'portfolio',
        url: 'https://example.com/portfolio/project-1',
        text: 'Realizzazione food truck personalizzato.',
        score: 0.8,
      }),
      makeResult({
        id: 'contacts',
        url: 'https://example.com/contatti',
        text: 'Email: info@example.com Telefono: +39 0437 859295',
        score: 0.74,
      }),
    ],
  });

  assert.equal(out.results[0]?.id, 'contacts');
});

test('penalizes showcase pages when query does not ask for examples', () => {
  const out = applyHeuristicRerank({
    query: 'quali servizi offrite',
    results: [
      makeResult({
        id: 'showcase',
        url: 'https://example.com/portfolio/project-1',
        text: 'Progetto realizzato per cliente riservato.',
        score: 0.88,
      }),
      makeResult({
        id: 'services',
        url: 'https://example.com/servizi/allestimento',
        text: 'Servizi di allestimento, progettazione e assistenza.',
        score: 0.8,
      }),
    ],
  });

  assert.equal(out.results[0]?.id, 'services');
});

test('applies token-coverage filter on generic non-pricing queries', () => {
  const out = applyHeuristicRerank({
    query: 'servizi allestimento progettazione assistenza',
    results: [
      makeResult({
        id: 'weak',
        url: 'https://example.com/portfolio/rimorchio',
        text: 'Cliente riservato, progetto speciale.',
        score: 0.95,
      }),
      makeResult({
        id: 'service-1',
        url: 'https://example.com/servizi',
        text: 'Servizi di allestimento, progettazione e assistenza completa.',
        score: 0.72,
      }),
      makeResult({
        id: 'service-2',
        url: 'https://example.com/chi-siamo',
        text: 'Servizi e assistenza tecnica per clienti professionali.',
        score: 0.7,
      }),
    ],
  });

  assert.equal(out.debug.coverageFilterApplied, true);
  assert.equal(out.results.some((r) => r.id === 'weak'), false);
});

test('boosts pricing chunks with numeric/currency evidence', () => {
  const out = applyHeuristicRerank({
    query: 'avete i prezzi dei vostri prodotti?',
    results: [
      makeResult({
        id: 'generic',
        url: 'https://example.com/faq',
        text: 'Informazioni generiche su permessi e attivita.',
        score: 0.9,
      }),
      makeResult({
        id: 'pricing',
        url: 'https://example.com/listino-prezzi',
        text: 'Prezzi: acquisto da 45.000 euro, noleggio da 25.000 euro.',
        score: 0.78,
      }),
    ],
  });

  assert.equal(out.results[0]?.id, 'pricing');
  assert.equal(out.debug.coverageFilterApplied, false);
});
