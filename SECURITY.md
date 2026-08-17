# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or leaked
credential. Use GitHub's private vulnerability reporting feature in the
repository's **Security** tab.

Include the affected version or commit, reproduction steps, expected impact,
and any suggested mitigation. Maintainers will acknowledge a report as soon as
practical and coordinate disclosure after a fix is available.

## Local security model

The shim binds its HTTP services and desktop ports to loopback by default. Do
not expose ports `6080`, `8443`, or `8550` to an untrusted network. The local
TLS certificate and all application profiles, tokens, logs, and generated host
files are intentionally excluded from Git.
