# Universal AI API Hub

A configurable, multi-provider AI API hub built for the assignment brief. Administrators can create connectors with dynamic fields, JSON output schemas, generated authenticated endpoints, documentation, a test console, and persistent usage logs.

## Run locally

1. Copy `.env.example` to `.env` and set at least one provider key.
2. Run `npm run dev`.
3. Open `http://localhost:3000`.

The app stores its local database in `data/api-hub.db`. The default dashboard is intentionally open for evaluation. Set `ADMIN_TOKEN` in production and send it as `x-admin-token` for admin API routes.

## Providers

- OpenAI: `OPENAI_API_KEY`
- Google Gemini: `GEMINI_API_KEY`
- Groq (optional free second provider): `GROQ_API_KEY`

## Generated endpoint

`POST /v1/:slug` accepts JSON or multipart form data. Send the connector API key as `Authorization: Bearer <key>` or `x-api-key: <key>`. Documentation is available at `/docs/:slug`.

## Public deployment (Render)

1. Push this repository to a private GitHub repository. Do not commit `.env`.
2. In Render, create a new Blueprint and select the repository. It reads `render.yaml`.
3. Enter `GEMINI_API_KEY` as a Render environment secret. Set `PUBLIC_URL` to the deployment URL after its first deploy.
4. On Render's free plan, the local SQLite connector and usage-log data can be lost when the service restarts. For final evaluation, use a paid persistent disk or replace SQLite with a hosted database such as Supabase Postgres.
5. Open the generated public URL and verify `/api/health`, `/docs/content-rewriter`, and one authenticated `POST /v1/...` request.

## Demo connectors

**Content Rewriter**: Gemini / `gemini-flash-lite-latest`; text + optional tone -> `rewritten_text`, `summary`.

**Business Card Scanner**: Gemini / `gemini-flash-lite-latest`; multipart `image` file -> name, company, designation, phone, email, website. Use the test console's file picker or a multipart cURL request.
