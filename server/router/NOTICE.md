# Router notice

The embedded router in `server/router/` is an original, from-scratch
implementation of an OpenAI-compatible `/v1/chat/completions` router for
Gemini / Groq / OpenRouter only (the three providers this agent uses). It was
written for this project — it is NOT a copy of FreeLLMAPI's code.

FreeLLMAPI (MIT, https://github.com/faridahmed6682-bussiness/freellmapi) is
the upstream inspiration and remains an optional external override: set
`FREE_LLM_API_URL` + `FREE_LLM_API_KEY` to point this agent at a deployed
FreeLLMAPI instead of the embedded router. Upstream FreeLLMAPI updates are
NOT pulled automatically — merging them is a manual step.

Licence: MIT (see the repo-root LICENSE).
