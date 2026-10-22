# Mermaid (vendored)

- Package: `mermaid`
- Version: `12.2.0`
- Source: `https://unpkg.com/mermaid@12.2.0/dist/mermaid.min.js`
- License: MIT, see `LICENSE`

The studio loads this file only when a rendered session contains a Mermaid
diagram. It is committed so the dashboard works on an air-gapped machine with
no CDN and no network access.

To update it, replace `mermaid.min.js` and `LICENSE` from the same package
version, then check a diagram in the Enhancement or Feature session reader.
