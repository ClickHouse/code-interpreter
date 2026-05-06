# CodeAPI

Sandboxed code execution service for LibreChat, providing secure execution of user-submitted code with file storage and tool calling capabilities.

## Overview

CodeAPI is a multi-component service that enables LibreChat to safely execute user code in isolated sandboxes. It consists of five independently scalable components that communicate via Redis queues and S3-compatible storage.

## Components

- **API** - HTTP gateway that accepts code execution requests and returns results
- **Worker Sandbox** - Executes code in NsJail (or libkrun microVM) sandboxes with resource limits
- **File Server** - Manages file uploads/downloads via S3 (IRSA authentication)
- **Tool Call Server** - Handles programmatic tool calls from within sandbox sessions
- **Package Init** - One-time job that pre-installs language runtimes (Python, Node, Bun) onto a shared PVC

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

## Local Development

```bash
docker-compose up --build
```

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`
