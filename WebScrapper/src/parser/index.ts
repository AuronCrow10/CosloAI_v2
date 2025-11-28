import * as cheerio from 'cheerio';
import { ParsedPage } from '../types.js';

/**
 * Remove obvious boilerplate nodes (nav, footer, etc.) and extract main text.
 * This is a heuristic, not a full Readability port, but good enough as a base.
 */
export function parseHtmlToText(
  html: string,
  url: string,
  domain: string,
): ParsedPage {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || undefined;

  // Remove scripts, styles, and common clutter
  const removalSelectors = [
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'iframe',
    '.cookie-banner',
    '.cookie-banner__wrapper',
    '[id*="cookie"]',
    '[class*="cookie"]',
    '[id*="banner"]',
    '[class*="banner"]',
    '[role="navigation"]',
    '[aria-label="Breadcrumb"]',
  ].join(',');

  $(removalSelectors).remove();

  // Try main first, then article, then body
  let mainText = $('main').text();
  if (!mainText || mainText.trim().length < 200) {
    mainText = $('article').text();
  }
  if (!mainText || mainText.trim().length < 200) {
    mainText = $('body').text();
  }

  const rawText = mainText || '';

  // Normalize whitespace: preserve paragraph-ish breaks but squash multiples
  const cleanedText = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();

  return {
    url,
    domain,
    title,
    rawHtml: html,
    rawText,
    cleanedText,
  };
}
