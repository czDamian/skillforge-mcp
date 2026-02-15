// Load environment variables first
import "./env.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { blockchainSkillClient } from "./client/blockchain-skill-client.js";
import axios from "axios";
import { logger } from "./utils/logger.js";
import express from "express";
import cors from "cors";

// Initialize the MCP server
const server = new McpServer({
    name: "skillforge-mcp",
    version: "1.0.0",
});

async function main() {
    logger.info("Starting SkillForge MCP Server (SSE Mode)...");

    const registeredTools = new Set<string>();

    async function syncSkills() {
        try {
            logger.info("Synchronizing skills from blockchain...");
            // Clear metadata cache so we pick up IPFS updates
            blockchainSkillClient.clearCache();

            const currentSkills = await blockchainSkillClient.listSkills();

            // Register each skill as a tool
            for (const skill of currentSkills) {
                const toolName = skill.name
                    .toLowerCase()
                    .replace(/\s+/g, "-")
                    .replace(/[^a-z0-9-]/g, "");

                server.tool(
                    toolName,
                    `${skill.description}\n(SkillForge ID: ${skill.skillId})`,
                    {
                        input: z.string().describe("Input parameters for the skill"),
                    },
                    async ({ input }) => {
                        logger.info(`Requested execution of skill: ${skill.name} (${skill.skillId})`);

                        try {
                            const apiUrl = process.env.SKILLFORGE_API_URL || "http://localhost:3000";
                            const endpoint = `${apiUrl}/api/agent`;

                            const response = await axios.post(endpoint, {
                                skillId: Number(skill.skillId),
                                input,
                                buyer: blockchainSkillClient.getAccountAddress(),
                            });

                            const result = response.data;

                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Skill executed successfully!\nResult:\n${JSON.stringify(result, null, 2)}`,
                                    },
                                ],
                            };

                        } catch (error) {
                            logger.error("Execution error caught in index.ts:", error);
                            let message = "Unknown error";

                            if (error instanceof Error) {
                                message = error.message;
                                if ((error as any).isAxiosError && (error as any).code === 'ECONNREFUSED') {
                                    message = `Backend server unreachable at ${process.env.SKILLFORGE_API_URL || 'localhost:3000'}. Ensure the SkillForge app is running.`;
                                } else if ((error as any).response?.data?.error) {
                                    message = (error as any).response.data.error;
                                }
                            } else if (typeof error === 'string') {
                                message = error;
                            } else {
                                message = JSON.stringify(error);
                            }

                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Error executing skill "${skill.name}": ${message}`,
                                    },
                                ],
                                isError: true,
                            };
                        }
                    }
                );

                if (!registeredTools.has(toolName)) {
                    logger.info(`[Sync] Registered new tool: ${toolName}`);
                    registeredTools.add(toolName);
                }
            }

            logger.info(`[Sync] Completed. ${currentSkills.length} skills active.`);
        } catch (error) {
            logger.error("[Sync] Failed to synchronize skills:", error);
        }
    }

    // Initial sync
    await syncSkills();

    // Set up periodic sync (every 5 minutes)
    const SYNC_INTERVAL = 5 * 60 * 1000;
    setInterval(syncSkills, SYNC_INTERVAL);
    logger.info(`Dynamic skill sync enabled (Interval: 5m)`);

    // SSE Setup
    const app = express();
    app.use(cors());

    let transport: SSEServerTransport | null = null;

    app.get("/sse", async (req, res) => {
        logger.info("New SSE connection established");
        transport = new SSEServerTransport("/message", res);
        await server.connect(transport);
    });

    app.post("/message", async (req, res) => {
        if (!transport) {
            res.status(400).send("No active SSE transport");
            return;
        }
        logger.debug("Received message via SSE transport");
        await transport.handlePostMessage(req, res);
    });

    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`SkillForge MCP (SSE) running on port ${PORT}`);
        logger.info(`- SSE Endpoint: http://localhost:${PORT}/sse`);
        logger.info(`- Message Endpoint: http://localhost:${PORT}/message`);
    });
}

main().catch((error) => {
    logger.error("Fatal error in main():", error);
    process.exit(1);
});
