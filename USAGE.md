# SkillForge MCP Installation Guide (Cloud/SSE)

Connect the SkillForge Marketplace to your AI Agent using Server-Sent Events (SSE). This allows you to use skills via a hosted URL without installing local code.

## 1. Hosting (Optional)
If you are the developer, you can deploy this MCP server to **Render**, **Fly.io**, or any Node.js host.

```bash
cd mcp
npm install
npm run build
PORT=3000 node build/index.js
```

## 2. Configuration for AI Clients

### Gemini CLI
Add the server to your `gemini.config.json` using the `sse` transport type:

```json
{
  "mcpServers": {
    "skillforge": {
      "url": "https://skillforge-mcp.onrender.com/sse"
    }
  }
}
```

### Claude Desktop
For Claude Desktop, you need to use a shim or a proxy that supports SSE, as Claude primarily uses `stdio`.

To use SSE in Claude Desktop, you typically use a command to bridge the connection:

```json
{
  "mcpServers": {
    "skillforge": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/inspector", "https://your-skillforge-mcp.onrender.com/sse"]
    }
  }
}
```

## 3. Environment Variables (Backend)
When deploying, ensure these environment variables are set:

| Variable | Description |
| --- | --- |
| `MONAD_RPC_URL` | Monad Testnet RPC |
| `NEXT_PUBLIC_SKILL_REGISTRY_ADDRESS` | Address of the Skill Registry contract |
| `SKILLFORGE_API_URL` | Your SkillForge backend URL (e.g. `http://localhost:3000`) |
| `GEMINI_API_KEY` | Your Google Gemini API key for AI execution |
| `PRIVATE_KEY` | Wallet private key to resolve blockchain queries |

## 4. Usage
Once connected, simply ask the AI to perform a task:
*"Can you use SkillForge to uppercase this text: 'monad is fast'?"*
