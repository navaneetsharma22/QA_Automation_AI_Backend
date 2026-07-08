/**
 * AI Models Configuration (Groq, Gemini, OpenAI, Claude, DeepSeek, Ollama)
 */
const AI_PROVIDERS = {
  GROQ: {
    name: 'Groq',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama-3.1-8b-instant'],
    defaultModel: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1',
    speedRank: 'Ultra Fast (~300 tokens/sec)',
  },
  GEMINI: {
    name: 'Gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    defaultModel: 'gemini-2.5-pro',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    speedRank: 'High Speed & Multimodal',
  },
  OPENAI: {
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    defaultModel: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    speedRank: 'Industry Benchmark Reasoning',
  },
  CLAUDE: {
    name: 'Claude',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-3-5-sonnet-20241022',
    baseUrl: 'https://api.anthropic.com/v1',
    speedRank: 'Superior Nuance & Context Evaluation',
  },
  DEEPSEEK: {
    name: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    speedRank: 'High Reasoning Accuracy',
  },
  OLLAMA: {
    name: 'Ollama (Local/On-Prem)',
    models: ['llama3:latest', 'mistral:latest', 'qwen2.5:latest'],
    defaultModel: 'llama3:latest',
    baseUrl: 'http://localhost:11434/api',
    speedRank: 'Zero Data Leakage / Local Execution',
  },
  OPENROUTER: {
    name: 'OpenRouter',
    models: ['meta-llama/llama-3.1-8b-instruct', 'deepseek/deepseek-r1'],
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    baseUrl: 'https://openrouter.ai/api/v1',
    speedRank: 'Unified Access to Multi-Models',
  },
  HUGGINGFACE: {
    name: 'Hugging Face',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    baseUrl: 'https://router.huggingface.co/v1',
    speedRank: 'Open Source Community Models',
  },
};

module.exports = { AI_PROVIDERS };
