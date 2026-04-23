# Security Policy

## Reporting a vulnerability

If you find a security issue in Keddy, please report it privately rather than opening a public GitHub issue.

**Email:** emire.aksay@gmail.com

Include:

- A description of the issue and its impact
- Steps to reproduce
- A proof of concept if you have one
- Whether you believe it's exploitable in the default Keddy configuration

We'll acknowledge receipt within 48 hours and keep you updated as we work through it. Once a fix ships, we'll credit you in the release notes unless you ask us not to.

## Scope

Keddy is local-first. The threat model is narrow but real.

**In scope**

- SQL injection in search or any dashboard API route
- Path traversal in JSONL parsing
- API key leakage from `~/.keddy/config.json`
- Dashboard request smuggling, CSRF, or XSS (including SVG-borne)
- Hook-handler command injection
- Any vulnerability that turns session capture into code execution

**Out of scope**

- Physical access to the user's machine (cold-boot, disk forensics)
- Attacks that require the user to install a malicious Keddy build from somewhere other than npm
- DoS against the local dashboard from localhost

## Responsible disclosure

Please don't disclose publicly until we've shipped a fix. We'll coordinate timing with you.
