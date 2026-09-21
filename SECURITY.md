# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use one of the following private channels:

1. **GitHub Security Advisories** — preferred. Open a private report at
   <https://github.com/andtii/agentic/security/advisories/new>.
2. **Email** — contact the maintainer directly: **Andreas Ekdahl**
   <andy@ekdahls.net>.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally a minimal proof of concept.
- Affected package(s) and version(s).
- Any suggested mitigation, if you have one.

## Response

- We aim to acknowledge new reports within a few business days.
- Once a fix is ready, a patched version will be published to npm and a
  security advisory will be posted on GitHub crediting the reporter
  (unless they prefer to remain anonymous).

## Supported versions

Nothing is published to npm; the deployed Worker and the daemon's `stable`
release channel track `main`. Security fixes land on `main` and ship in the
next daemon release.
