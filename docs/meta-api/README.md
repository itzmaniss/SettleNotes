# Meta Model API doc snapshots

Fetched 30 Oct 2026 from `https://dev.meta.ai/docs/<page>.md`. Trust these over model memory. Refresh with:
`curl -sL "https://dev.meta.ai/docs/<page>.md" -o <file>.md`

| File | Use it for |
| --- | --- |
| quickstart.md | Base URL `https://api.meta.ai/v1`, `MODEL_API_KEY`, first call in TS |
| models.md | Model IDs, capabilities, Spark 1.3 audio caveat, country availability note |
| pricing-rate-limits.md | Prices (cost logging), rate limits and headers |
| protocols-responses.md | Responses API request/response shapes (our default surface) |
| structured-output.md | `text.format` json_schema, strict subset rules, schema limits |
| reasoning.md | `reasoning.effort` levels |
| image-understanding.md | `input_image`, base64 data URLs, perception grounding (0-1000 bbox grid) |
| file-handling.md | PDF input (`input_file`), Files API, PDF page limits |
| video-audio-understanding.md | `input_audio` (wav/mp3) on Spark |
| speech-to-text.md | Muse Voice Transcribe `/v1/asr/transcribe`, WAV requirements, languageBias, keywords |
