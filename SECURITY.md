# Security Policy

Reverie holds an agent's memory: the people, organisations and projects it knows, and how they
relate. We treat a vulnerability in it as a vulnerability in every agent that runs it, so please
report anything you find, and please do it privately.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: use GitHub's private vulnerability reporting on this repository
  (**Security → Report a vulnerability**). It creates a proposed advisory that only you and the
  repository's security managers can see.
- Otherwise: email **support@knowall.ai**. If you need to encrypt, say so in a first message and
  we will send a key.

Include what you can: the version or commit, the component (MCP server, Hermes plugin, brain
API, Dreaming), steps to reproduce, and the impact you believe it has. A minimal proof of concept
is welcome; please do not run it against a graph you do not own.

## What to expect

- **Acknowledgement within 3 working days.**
- **An initial assessment within 10 working days**, with a severity and a plan.
- **A fix for confirmed high or critical issues within 30 days**, sooner where practical. Lower
  severities are scheduled into the next release.
- We will keep you informed, credit you in the release notes if you wish, and tell you before
  anything about the report is made public.

We do not run a paid bug bounty at present.

## Scope

In scope: this repository's code and configuration, the published package, the tools it exposes
to agents, and the way it handles Neo4j credentials, embedding-provider credentials and
caller-supplied Cypher.

Things we would particularly like to hear about:

- Any way for a caller of `query_memories` (or the read-only `cypher` action) to write to, or
  read outside of, the graph.
- Credential or memory-content leakage through logs, tool results, error messages or the brain
  view API.
- Injection through node properties, labels or relationship types that reaches Cypher unescaped.
- Ways a crafted prompt or memory could make an agent's recall pull in content it should not.

Out of scope: vulnerabilities in Neo4j, APOC, Node.js, Python or the embedding providers
themselves (please report those upstream), issues that require an already-compromised host or
unauthorised access to the Neo4j credentials, and findings from automated scanners with no
demonstrated impact. Credential leakage and access-control failures that you can reproduce with
your own authenticated setup are in scope.

## Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue legal action or a
complaint to your provider, and we will work with you to understand and resolve the issue quickly.
Please avoid privacy violations, data destruction, and disruption of KnowAll's or its clients'
agents while researching.

## Supported versions

Security fixes are made on the latest release only. Please upgrade before reporting if you are on
an older version and the problem may already be fixed.
