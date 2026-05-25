# Security Policy

We take the security of vibe-term and its users seriously. This document explains how to report vulnerabilities, what is in scope, and what to expect from us.

## Supported versions

vibe-term is pre-1.0 software under active development. Only the latest minor release line receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | Yes (latest minor) |
| < 0.x   | No                 |

Once 1.0 ships, this table will be updated to reflect a longer-term support window.

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub issue, pull request, or Discussion thread for a suspected vulnerability.

The preferred channel is GitHub Security Advisories:

1. Go to https://github.com/mobel8/vibe-term/security/advisories/new
2. Provide a clear description, reproduction steps, affected versions, and any proof-of-concept.
3. We will acknowledge receipt and coordinate a fix with you privately.

If you cannot use Security Advisories, contact the maintainers listed in `.github/CODEOWNERS` through their public GitHub profiles and request a private channel.

When reporting, please include:

- A description of the vulnerability and its impact.
- Steps to reproduce or a proof-of-concept.
- Affected version(s), operating system, and shell.
- Any suggested mitigation, if known.

## Scope

In scope:

- The vibe-term desktop application (frontend, Tauri backend, PTY layer).
- Bundled scripts and configuration files in this repository.
- The official release artifacts published from this repository.

Out of scope:

- Vulnerabilities in self-hosted reverse proxies, custom shells, or third-party tools that you place in front of or inside vibe-term.
- Leakage of third-party API keys (for example, Anthropic API keys) caused by user misconfiguration or by sharing logs publicly.
- Issues that require physical access to an unlocked machine.
- Social engineering of maintainers or contributors.

## Response timeline

We aim for the following turnaround, on a best-effort basis given that this is an open-source project:

- Initial triage and acknowledgement: within 72 hours.
- Fix target for critical vulnerabilities: within 14 days of confirmation.
- Coordinated public disclosure: after a fix is available, in agreement with the reporter.

We will keep you informed of progress and credit you in the advisory unless you request otherwise.

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and service interruption.
- Report the issue privately and give us reasonable time to remediate before public disclosure.
- Do not exploit the vulnerability beyond what is necessary to demonstrate it.

## Hall of fame

We thank the following people for their responsible disclosures:

- _Your name could be here._
