#!/usr/bin/env node
// MCP server: full Google Patents record via SerpApi `google_patents_details` engine.
// Key: SERPAPI_API_KEY env var, falling back to %USERPROFILE%\.google-patents-mcp.env.
// stdout is reserved for the MCP protocol — diagnostics go to stderr only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENV_FILE = path.join(os.homedir(), '.google-patents-mcp.env');
const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

const SECTIONS = [
  'biblio', 'abstract', 'claims', 'description', 'classifications', 'family',
  'citations', 'cited_by', 'legal_events', 'timeline', 'similar', 'images',
];
const DEFAULT_SECTIONS = SECTIONS.filter((s) => s !== 'similar' && s !== 'images');

function loadApiKey() {
  if (process.env.SERPAPI_API_KEY) return process.env.SERPAPI_API_KEY.trim();
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*SERPAPI_API_KEY\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // fall through
  }
  return null;
}

// Accepts "US10319978B2", "US 10,319,978 B2", "patent/US10319978B2/en",
// "https://patents.google.com/patent/US10319978B2/en", "scholar/123".
function normalizePatentId(raw, language) {
  let id = raw.trim().replace(/^https?:\/\/patents\.google\.com\//i, '').replace(/[?#].*$/, '');
  if (/^(patent|scholar)\//i.test(id)) {
    const [kind, ...rest] = id.split('/');
    if (kind.toLowerCase() === 'scholar') return `scholar/${rest.join('/')}`;
    const num = (rest[0] || '').replace(/[\s,]/g, '').toUpperCase();
    const lang = rest[1] || language;
    return `patent/${num}/${lang}`;
  }
  return `patent/${id.replace(/[\s,/-]/g, '').toUpperCase()}/${language}`;
}

const cache = new Map(); // key -> { at, value }

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchDetails(patentId, apiKey) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_patents_details');
  url.searchParams.set('patent_id', patentId);
  url.searchParams.set('api_key', apiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`SerpApi returned HTTP ${res.status} with non-JSON body`);
  if (body.error) throw new Error(`SerpApi: ${body.error}`);
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  return body;
}

async function fetchDescription(link) {
  const res = await fetch(link, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`description HTTP ${res.status}`);
  return descriptionHtmlToText(await res.text());
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function descriptionHtmlToText(html) {
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  const text = body
    .replace(/<heading[^>]*>([\s\S]*?)<\/heading>/gi, '\n\n## $1\n')
    .replace(/<div[^>]*\bnum="(\d+)"[^>]*>/gi, '\n[$1] ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<sub>([\s\S]*?)<\/sub>/gi, '_$1')
    .replace(/<sup>([\s\S]*?)<\/sup>/gi, '^$1')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

function list(items, max, fmt) {
  if (!items?.length) return '_none_';
  const lines = items.slice(0, max).map(fmt);
  if (items.length > max) lines.push(`- … ${items.length - max} more (raise max_list_items)`);
  return lines.join('\n');
}

const citationLine = (c) =>
  `- ${c.publication_number} (${c.publication_date || c.priority_date || '?'})` +
  `${c.examiner_cited ? ' [examiner]' : ''} — ${clip(c.title, 140)}` +
  `${c.assignee_original ? ` — ${c.assignee_original}` : ''}`;

function citationBlock(group, max) {
  if (!group) return '_none_';
  const parts = [list(group.original, max, citationLine)];
  if (group.family_to_family?.length) {
    parts.push(`\nFamily-to-family (${group.family_to_family.length}):`);
    parts.push(list(group.family_to_family, max, citationLine));
  }
  return parts.join('\n');
}

function render(d, sections, opts, description) {
  const out = [];
  const want = (s) => sections.includes(s);

  out.push(`# ${d.publication_number || ''} — ${d.title || '(no title)'}`);

  if (want('biblio')) {
    const rows = [
      ['Type', d.type],
      ['Country', d.country],
      ['Application', d.application_number],
      ['Priority date', d.priority_date],
      ['Filing date', d.filing_date],
      ['Publication date', d.publication_date],
      ['Prior-art date', d.prior_art_date],
      ['Assignees', d.assignees?.join('; ')],
      ['Inventors', d.inventors?.map((i) => i.name).join('; ')],
      ['Family ID', d.family_id],
      ['PDF', d.pdf],
      ['Google Patents', d.search_metadata?.google_patents_details_url],
      ['Prior-art keywords', d.prior_art_keywords?.join(', ')],
    ].filter(([, v]) => v);
    out.push('\n## Bibliography\n' + rows.map(([k, v]) => `- **${k}:** ${v}`).join('\n'));
  }

  if (want('abstract')) out.push(`\n## Abstract\n${d.abstract || '_none_'}`);

  if (want('claims')) {
    const claims = d.claims || [];
    out.push(`\n## Claims (${claims.length})\n` + (claims.length ? claims.join('\n\n') : '_none_'));
  }

  if (want('classifications')) {
    const all = d.classifications || [];
    const leaf = all.filter((c) => c.leaf);
    const shown = leaf.length ? leaf : all;
    out.push(
      `\n## Classifications (${shown.length}${leaf.length ? ' leaf' : ''} of ${all.length})\n` +
        list(shown, 100, (c) => `- ${c.code}${c.first_code ? ' *' : ''}${c.description ? ` — ${c.description}` : ''}`),
    );
  }

  if (want('family')) {
    const apps = Object.entries(d.worldwide_applications || {}).flatMap(([, arr]) => arr);
    out.push(
      `\n## Family / worldwide applications (${apps.length})\n` +
        list(apps, opts.max_list_items, (a) =>
          `- ${a.filing_date} ${a.country_code} ${a.application_number} → ${a.document_id?.replace(/^patent\/|\/\w+$/g, '') || '?'}` +
          ` — ${a.legal_status || '?'}${a.this_app ? ' (this)' : ''}`),
    );
    const prio = d.priority_applications || [];
    if (prio.length) {
      out.push('\nPriority applications:\n' +
        list(prio, opts.max_list_items, (p) =>
          `- ${p.application_number} (prio ${p.priority_date}, filed ${p.filing_date}) → ${p.representative_publication}`));
    }
    for (const [key, label] of [['parent_applications', 'Parent'], ['child_applications', 'Child']]) {
      if (d[key]?.length) {
        out.push(`\n${label} applications:\n` +
          list(d[key], opts.max_list_items, (p) =>
            `- ${p.application_number || ''} ${p.relation_type || ''} ${p.representative_publication || ''} ${p.priority_date || ''}`.trim()));
      }
    }
  }

  if (want('citations')) {
    out.push(`\n## Patent citations (backward)\n${citationBlock(d.patent_citations, opts.max_list_items)}`);
    if (d.non_patent_citations?.length) {
      out.push('\nNon-patent citations:\n' +
        list(d.non_patent_citations, opts.max_list_items, (c) => `- ${clip(c.title, 200)}${c.examiner_cited ? ' [examiner]' : ''}`));
    }
  }

  if (want('cited_by')) out.push(`\n## Cited by (forward)\n${citationBlock(d.cited_by, opts.max_list_items)}`);

  if (want('legal_events')) {
    out.push(`\n## Legal events (${d.legal_events?.length || 0})\n` +
      list(d.legal_events, opts.max_list_items, (e) => {
        const attrs = (e.attributes || []).map((a) => `${a.label}: ${a.value}`).join('; ');
        return `- ${e.date} ${e.code} — ${e.title}${attrs ? ` (${clip(attrs, 250)})` : ''}`;
      }));
  }

  if (want('timeline')) {
    out.push(`\n## Timeline\n` +
      list(d.events, opts.max_list_items, (e) => `- ${e.date}${e.critical ? ' !' : ''} ${e.title}`));
  }

  if (want('similar')) {
    out.push(`\n## Similar documents\n` +
      list(d.similar_documents, opts.max_list_items, (s) =>
        `- ${s.publication_number || s.title} (${s.publication_date || '?'}) — ${clip(s.title, 140)}`));
  }

  if (want('images')) out.push(`\n## Images\n` + list(d.images, 100, (u) => `- ${u}`));

  if (want('description')) {
    if (description == null) {
      out.push(`\n## Description\n_not available${d.description_link ? '' : ' (no description_link in response)'}_`);
    } else {
      const start = Math.min(opts.description_offset, description.length);
      const end = Math.min(start + opts.description_max_chars, description.length);
      const more = end < description.length
        ? `\n\n_[truncated: chars ${start}–${end} of ${description.length}; call again with description_offset=${end} for more — served from cache, no extra SerpApi credit]_`
        : '';
      out.push(`\n## Description (chars ${start}–${end} of ${description.length})\n${description.slice(start, end)}${more}`);
    }
  }

  return out.join('\n');
}

const server = new McpServer({ name: 'google-patents-details', version: '0.1.0' });

server.registerTool(
  'get_patent_details',
  {
    title: 'Google Patents: full patent record',
    description:
      'Fetch the full Google Patents record for one patent via SerpApi (engine google_patents_details): ' +
      'bibliography, abstract, full claims, full description text, CPC classifications, worldwide family, ' +
      'backward/forward citations, legal events and timeline. Costs 1 SerpApi search per patent; ' +
      'repeat calls for the same patent within 1 hour (e.g. paging the description) are served from cache. ' +
      'Use the `sections` parameter to fetch only what you need and keep output small.',
    inputSchema: {
      patent_id: z.string().min(2).describe(
        'Publication number or Google Patents id, e.g. "US10319978B2", "EP2549025A1", "CN108963184B", ' +
        '"patent/US10319978B2/en", a patents.google.com URL, or "scholar/<id>".'),
      language: z.string().default('en').describe('Page language for translations (default "en").'),
      sections: z.array(z.enum(SECTIONS)).optional().describe(
        `Sections to include. Default: ${DEFAULT_SECTIONS.join(', ')}. Also available: similar, images.`),
      description_offset: z.number().int().min(0).default(0).describe('Start char of description text (for paging).'),
      description_max_chars: z.number().int().min(200).max(200000).default(20000)
        .describe('Max description chars to return in this call (default 20000).'),
      max_list_items: z.number().int().min(1).max(500).default(30)
        .describe('Max items per list section: citations, family, legal events, etc. (default 30).'),
    },
  },
  async (args) => {
    const apiKey = loadApiKey();
    if (!apiKey) {
      return {
        isError: true,
        content: [{ type: 'text', text: `SERPAPI_API_KEY not set (env var or ${ENV_FILE}).` }],
      };
    }
    try {
      const patentId = normalizePatentId(args.patent_id, args.language);
      const sections = args.sections?.length ? args.sections : DEFAULT_SECTIONS;
      const details = await cached(`d:${patentId}`, () => fetchDetails(patentId, apiKey));

      let description = null;
      if (sections.includes('description') && details.description_link) {
        try {
          description = await cached(`t:${details.description_link}`, () => fetchDescription(details.description_link));
        } catch (e) {
          process.stderr.write(`description fetch failed: ${e.message}\n`);
        }
      }

      const text = render(details, sections, args, description);
      return { content: [{ type: 'text', text: `patent_id: ${patentId}\n\n${text}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write('google-patents-details MCP server running on stdio\n');
