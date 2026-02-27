import axios from 'axios';
import * as cheerio from 'cheerio';
import { askLLM } from './llm.js';

function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchWebsiteText(url) {
  const { data: html } = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Demo Salon Bot Importer)'
    }
  });

  const $ = cheerio.load(html);

  $('script, style, noscript').remove();

  const title = cleanText($('title').first().text());
  const headings = $('h1, h2, h3')
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter(Boolean)
    .slice(0, 20);

  const bodyText = cleanText($('body').text()).slice(0, 12000);

  return {
    title,
    headings,
    bodyText
  };
}

export async function proposeKnowledgeUpdate(url) {
  const extracted = await fetchWebsiteText(url);

  const system = `You are a salon business knowledge extractor. Given website content, generate:
1. A structured FAQ array (JSON) with objects like {"q": "...", "a": "..."}
2. A SOUL.md behavior prompt for a WhatsApp salon assistant

Output ONLY valid JSON in this exact format:
{
  "faq_json": [{"q": "question", "a": "answer"}, ...],
  "soul_md": "You are the WhatsApp assistant for [salon name]..."
}

Rules:
- Extract real info from the website (services, hours, prices, location, contact)
- Keep FAQ answers short and practical
- Generate 5-15 FAQ entries from the content
- The SOUL.md should define the bot personality and salon context
- Do not invent information not present in the website content`;

  const user = `Website: ${url}
Title: ${extracted.title}
Headings: ${extracted.headings.join(', ')}
Content:
${extracted.bodyText}`;

  const result = await askLLM({ system, user });

  if (result.providerError) {
    throw new Error(`LLM failed during import: ${result.providerError}`);
  }

  // Parse the JSON from LLM response
  let proposed;
  try {
    // Try to extract JSON from the response (LLM sometimes wraps in markdown)
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in LLM response');
    proposed = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    throw new Error(`Failed to parse LLM proposal: ${parseErr.message}`);
  }

  if (!proposed.faq_json || !proposed.soul_md) {
    throw new Error('LLM proposal missing faq_json or soul_md');
  }

  return {
    url,
    extracted: {
      title: extracted.title,
      headingCount: extracted.headings.length,
      contentLength: extracted.bodyText.length
    },
    proposed
  };
}
