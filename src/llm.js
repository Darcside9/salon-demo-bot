import axios from 'axios';
import { estimateCostFromTokens } from './guardrails.js';

const DEFAULT_LLM_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function askLLM({ system, user }) {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  const baseUrl = process.env.LLM_BASE_URL || DEFAULT_LLM_URL;

  if (!apiKey || !model) {
    return {
      text: 'AI response is not configured yet. Please set the API key and model.',
      tokens: 0,
      costEst: 0,
      providerError: 'Missing LLM_API_KEY or LLM_MODEL'
    };
  }

  try {
    const { data } = await axios.post(baseUrl, {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.3
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });

    const raw = data?.choices?.[0]?.message?.content?.trim();
    const totalTokens = data?.usage?.total_tokens || 0;

    if (!raw) {
      throw new Error('Empty LLM response content');
    }

    // Strip chain-of-thought tags from reasoning models (e.g. DeepSeek)
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (!text) {
      throw new Error('LLM response was empty after stripping think tags');
    }

    return {
      text,
      tokens: totalTokens,
      costEst: estimateCostFromTokens(totalTokens),
      providerError: null
    };
  } catch (err) {
    const msg = err?.code === 'ECONNABORTED'
      ? 'LLM request timed out'
      : (err?.response?.data?.error?.message || err?.message || 'Unknown LLM error');

    console.error('LLM fallback error:', msg);

    // Demo-safe fallback so the bot does not look broken
    return {
      text: 'Thanks for your message. A staff member will reply shortly. (Demo fallback)',
      tokens: 0,
      costEst: 0,
      providerError: msg
    };
  }
}
