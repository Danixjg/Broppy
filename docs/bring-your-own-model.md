# Bring your own model

An organization's admin chooses the AI model that answers questions, on the Connectors page under **AI model**.

## What an admin sets

- **Provider:** Anthropic, OpenAI, or OpenAI-compatible (Azure OpenAI's compatible endpoint, vLLM, Ollama behind HTTPS, and similar).
- **Model:** the model name as the provider knows it.
- **Address:** only for OpenAI-compatible servers (or a gateway in front of Anthropic or OpenAI). It must be HTTPS and publicly reachable: addresses on this machine or a private network are refused.
- **API key:** stored in Supabase Vault, keyed by organization, and never returned by the API. Leave it empty on a later save to keep the saved key.

Saving makes one small real call to the provider first. A wrong key, model name or address is refused with a message and nothing is saved. Every change is audited (provider and model, never the key).

## Which model answers

1. The organization's model, when one is saved. If Broppy cannot read the setting, it answers with the built-in writer rather than send the organization's context to a model it did not choose.
2. Otherwise the operator's own model from `LLM_PROVIDER`, `LLM_API_KEY` and `LLM_MODEL` (local development).
3. Otherwise the built-in writer, which answers from the sources without an AI model.

If the chosen model is slow, rate limited, cut off or returns lines the sources don't back, the answer falls back to the built-in writer and the audit trail records why. The model only ever receives the passages the asker may see, with their question.

## Setup

Apply `infra/supabase/migrations/011_org_model.sql` (fresh projects: `infra/supabase/schema.sql`). Changes made on another API instance are picked up within 30 seconds.

## Not covered

- **Embeddings** (semantic search) still come from the operator's `EMBEDDING_*` settings. The index stores 1024-number vectors, so a different embedding model needs a re-index and is a separate change. Without embeddings, search uses keywords only.
- The Slack task score stays rule-based and calls no model.
- The model is per organization, not per person. One organization per API process still applies.
- A server name that resolves to a private address is not caught by the address check.
