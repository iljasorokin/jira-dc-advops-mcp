# Security / public hygiene

This repository is **public**. Do not commit:

- API tokens, PATs, passwords, or `*.env` files
- Internal hostnames or production URLs
- Personal absolute paths (`/Users/...`)
- Real issue keys, page/template IDs, or internal space/structure names

Use a **local TLS proxy** (e.g. `https://localhost:8443`) and credentials from env / Keychain only.

Before pushing, scan the tree for accidental org-specific strings and secrets.
