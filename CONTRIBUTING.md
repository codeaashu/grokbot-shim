# Contributing

Thanks for helping improve grokbot-shim.

## Development setup

1. Install the prerequisites documented in `README.md`.
2. Run `npm ci`.
3. Run `npm run setup` to generate local certificates and extract the runtime
   files from your own Grok Bot installation.
4. Run `npm run check` and `npm test` before opening a pull request.

Keep pull requests focused and explain user-visible behavior changes. Never
commit credentials, application profiles, request captures, generated TLS
keys, or files extracted from the Grok Bot installation.

By contributing, you agree that your contribution is licensed under the ISC
license in this repository.
