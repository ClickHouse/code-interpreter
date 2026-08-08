# Code Interpreter

Sandboxed code execution service for LibreChat, providing secure execution of user-submitted code with file storage and tool calling capabilities.

## Overview

Code Interpreter (internally `codeapi`, the prefix used by its env vars, images, and helm chart) is a multi-component service that enables LibreChat to safely execute user code in isolated sandboxes. It consists of five independently scalable components that communicate via Redis queues and S3-compatible storage.

## Components

- **API** - HTTP gateway that accepts code execution requests and returns results
- **Worker Sandbox** - Executes code in NsJail (or libkrun microVM) sandboxes with resource limits
- **File Server** - Manages file uploads/downloads via S3 (IRSA authentication)
- **Tool Call Server** - Handles programmatic tool calls from within sandbox sessions
- **Package Delivery** - Bakes Python, Node, and Bun into the default microVM
  block-root image; a package-init PVC mode remains available for direct NsJail
  development

## Architecture

1. LibreChat sends a code execution request to the **API**
2. API enqueues the job in Redis
3. **Worker Sandbox** picks up the job and executes code inside an isolated sandbox
4. Files are persisted/retrieved via the **File Server** (backed by S3)
5. Tool calls from within sandboxes are routed through the **Tool Call Server**

## Sandbox Isolation

Two modes are supported:

- **NsJail mode** (`kvmEnabled: false`): Direct NsJail sandboxing with Linux namespaces and cgroups
- **MicroVM mode** (`kvmEnabled: true`): libkrun microVM with its own kernel, NsJail runs inside the guest

## Security disclaimer

This service exists to run arbitrary, untrusted code — treat every
deployment decision accordingly.

In its full hardened configuration — MicroVM mode (`kvmEnabled: true`, so
sandboxed code runs under a separate guest kernel) with NsJail inside the
guest, seccomp filtering, the egress gateway in front of all
sandbox-originated traffic, network policies applied, signed execution
manifests, and `hardenedSandboxMode` left on — it is reasonably secure and
designed with defense in depth. NsJail-only mode shares the host kernel and
provides meaningfully weaker isolation: it is appropriate for local
development, not for executing untrusted code from people you don't trust.

No software is 100% secure. Sandbox escapes, kernel vulnerabilities, and
misconfiguration are all real risks for any code-execution system. Keep the
hardening defaults on, run the stack on isolated infrastructure with least
privilege, keep hosts patched, and deploy responsibly. If you believe you
have found a vulnerability, please report it privately rather than opening a
public issue (see [CONTRIBUTING](CONTRIBUTING.md)).

## Local Development

```bash
docker-compose up --build
```

The default KVM Compose path builds `sandbox-runner-baked`: the guest root and
`/pkgs` tree live in a read-only ext4 block image instead of a long-lived
virtio-fs mount. The first image build takes longer because it compiles the
language runtimes, but package-heavy workloads do not accumulate host file
descriptors in the launcher.

Setting `KVM_ENABLED=false` still selects the directory-root target and the
host package mount automatically for direct NsJail development.

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`

## Stateless npm declaration indexing

An opt-in `POST /v1/sandbox/npm-unit` route indexes the `.d.ts` surface of one
exact registry package without executing package code. It verifies the
lockfile-provided SHA-512 digest before decompression, retains only declaration
files plus the root `package.json`, and returns deterministic symbols/imports
with rejection and resource-usage telemetry. Enable it with
`npmUnit.enabled=true` in Helm or `CODEAPI_NPM_UNIT_ENABLED=true` in the main
Compose stack; it is disabled by default. This route uses direct synchronous
HTTP dispatch and does not create a Redis/BullMQ job or persist package state.
