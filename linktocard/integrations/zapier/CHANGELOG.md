# Changelog

`zapier-platform promote <version>` reads the entry for the version it promotes, so every version
pushed for users gets one here (packages/cli/docs/cli.md, promote).

## 1.0.0

First version.

- Create card image (`create_card_image`): POST /v1/images.
- Create PDF (`create_pdf`): POST /v1/pdf.
- Create card from link (`card_from_link`): POST /v1/cards/from-url.
- Start bulk PDFs (`start_bulk_pdfs`): POST /v1/batches.
- Find batch (`get_batch`): GET /v1/batches/{id}, with a zip file for every ZIP part of a finished
  batch (GET /v1/batches/{id}/zip?part=N, downloaded only when a later step uses it).
- Check link preview (`check_link_preview`): GET /v1/inspect.
- API key connection, checked with GET /v1/usage.
