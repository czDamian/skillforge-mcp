import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { logger } from "../utils/logger.js";
import dotenv from "dotenv";

// Fallback loading for test scripts that don't use index.ts
if (!process.env.PRIVATE_KEY) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dotenv = require('dotenv');
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envConfig = dotenv.parse(fs.readFileSync(envPath));
      for (const k in envConfig) {
        process.env[k] = envConfig[k];
      }
    }
  } catch (e) {
    // ignore
  }
}

export interface SkillRegistryData {
  skillId: bigint;
  creator: string;
  pricePerUse: bigint;
  metadataURI: string;
  isActive: boolean;
  totalCalls: bigint;
}

export interface SkillWithMetadata extends SkillRegistryData {
  name: string;
  description: string;
  category: string;
  image?: string;
  tags: string[];
}

// Minimal ABI for SkillRegistry
const SKILL_REGISTRY_ABI = parseAbi([
  "function getAllSkills() public view returns ((uint256 skillId, address creator, uint256 pricePerUse, string metadataURI, bool isActive, uint256 totalCalls)[])",
  "function getSkill(uint256 skillId) public view returns (uint256 skillId, address creator, uint256 pricePerUse, string metadataURI, bool isActive, uint256 totalCalls)",
  "function getTotalSkills() public view returns (uint256)",
] as const);

// Minimal ABI for SkillPayment (purchaseSkill and events)
const SKILL_PAYMENT_ABI = parseAbi([
  "function purchaseSkill(uint256 skillId) external payable returns (bytes32)",
  "event SkillPurchased(bytes32 indexed transactionId, uint256 indexed skillId, address indexed buyer, uint256 amount)",
] as const);

export class BlockchainSkillClient {
  private publicClient;
  private walletClient;
  private account: Account;
  private registryAddress: string;
  private paymentAddress: string;
  private metadataCache: Map<string, SkillWithMetadata> = new Map();

  constructor(
    registryAddress: string = process.env.NEXT_PUBLIC_SKILL_REGISTRY_ADDRESS!,
    paymentAddress: string = process.env.NEXT_PUBLIC_PAYMENT_CONTRACT_ADDRESS!,
    rpcUrl: string = process.env.MONAD_RPC_URL!,
    privateKey: string = process.env.PRIVATE_KEY!,
  ) {
    this.registryAddress = (
      registryAddress as `0x${string}`
    ).toLowerCase() as `0x${string}`;
    this.paymentAddress = (
      paymentAddress as `0x${string}`
    ).toLowerCase() as `0x${string}`;

    if (!privateKey) {
      throw new Error("PRIVATE_KEY environment variable is required");
    }

    this.account = privateKeyToAccount(privateKey as `0x${string}`);

    this.publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: monadTestnet,
      transport: http(rpcUrl),
    });

    logger.debug(
      `BlockchainSkillClient initialized. Registry: ${this.registryAddress}, Payment: ${this.paymentAddress}, Account: ${this.account.address}`,
    );
  }

  async listSkills(): Promise<SkillWithMetadata[]> {
    try {
      logger.debug("Fetching all skills from blockchain...");

      const rawSkills = await this.publicClient.readContract({
        address: this.registryAddress as `0x${string}`,
        abi: SKILL_REGISTRY_ABI,
        functionName: "getAllSkills",
      });

      if (!Array.isArray(rawSkills)) {
        throw new Error("getAllSkills did not return an array");
      }

      logger.info(`Found ${rawSkills.length} skills on blockchain`);

      const skillsWithMetadata = await Promise.all(
        rawSkills.map((skill: any) => this.enrichSkillWithMetadata(skill)),
      );

      const activeSkills = skillsWithMetadata.filter((s) => s.isActive);
      logger.info(`${activeSkills.length} active skills available`);

      return activeSkills;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to list skills from blockchain: ${message}`);
      return [];
    }
  }

  //skip for now
  async purchaseSkill(skillId: bigint, price: bigint): Promise<string> {
    try {
      logger.info(
        `Purchasing skill #${skillId} for ${price} wei from ${this.account.address}...`,
      );

      const hash = await this.walletClient.writeContract({
        address: this.paymentAddress as `0x${string}`,
        abi: SKILL_PAYMENT_ABI,
        functionName: "purchaseSkill",
        args: [skillId],
        value: price,
      });

      logger.info(`Transaction sent: ${hash}. Waiting for confirmation...`);

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
      });

      if (receipt.status !== "success") {
        throw new Error(`Transaction failed: ${hash}`);
      }

      const logs = parseEventLogs({
        abi: SKILL_PAYMENT_ABI,
        eventName: "SkillPurchased",
        logs: receipt.logs,
      });

      if (logs.length === 0) {
        throw new Error("SkillPurchased event not found in transaction logs");
      }

      const transactionId = logs[0].args.transactionId;
      logger.info(
        `Skill purchased successfully. Transaction ID: ${transactionId}`,
      );

      return transactionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to purchase skill: ${message}`);
      throw error;
    }
  }

  getAccountAddress(): string {
    return this.account.address;
  }

  private async enrichSkillWithMetadata(
    rawSkill: any,
  ): Promise<SkillWithMetadata> {
    const skillId = BigInt(rawSkill.skillId !== undefined ? rawSkill.skillId : rawSkill[0]);
    const cacheKey = skillId.toString();

    if (this.metadataCache.has(cacheKey)) {
      return this.metadataCache.get(cacheKey)!;
    }

    const skill: SkillWithMetadata = {
      skillId: skillId,
      creator: rawSkill.creator !== undefined ? rawSkill.creator : rawSkill[1],
      pricePerUse: BigInt(rawSkill.pricePerUse !== undefined ? rawSkill.pricePerUse : rawSkill[2]),
      metadataURI: rawSkill.metadataURI !== undefined ? rawSkill.metadataURI : rawSkill[3],
      isActive: rawSkill.isActive !== undefined ? rawSkill.isActive : rawSkill[4],
      totalCalls: BigInt(rawSkill.totalCalls !== undefined ? rawSkill.totalCalls : rawSkill[5]),
      name: `Skill #${skillId}`,
      description: "No description available",
      category: "General",
      tags: [],
    };

    if (skill.metadataURI && skill.metadataURI.length > 0) {
      try {
        const metadata = await this.fetchIPFSMetadata(skill.metadataURI);
        if (metadata) {
          skill.name = metadata.name || skill.name;
          skill.description = metadata.description || skill.description;
          skill.category = metadata.category || skill.category;
          skill.image = metadata.image;
          skill.tags = metadata.tags || [];
        }
      } catch (err) {
        logger.debug(`Could not fetch metadata for skill ${skillId}: ${err}`);
      }
    }

    this.metadataCache.set(cacheKey, skill);
    return skill;
  }

  private async fetchIPFSMetadata(
    metadataURI: string,
  ): Promise<Partial<SkillWithMetadata> | null> {
    try {
      let hash = metadataURI;
      if (hash.startsWith("ipfs://")) {
        hash = hash.replace("ipfs://", "");
      } else if (hash.includes("/ipfs/")) {
        hash = hash.split("/ipfs/")[1];
      }

      // List of gateways to try
      const gateways = [
        `https://gateway.pinata.cloud/ipfs/${hash}`,
        `https://ipfs.io/ipfs/${hash}`,
        `https://dweb.link/ipfs/${hash}`
      ];

      for (const url of gateways) {
        try {
          logger.debug(`[Metadata] Fetching from: ${url}`);

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout per gateway

          const start = Date.now();
          const response = await fetch(url, { signal: controller.signal });
          const duration = Date.now() - start;
          clearTimeout(timeoutId);

          if (response.ok) {
            const text = await response.text();
            try {
              const json = JSON.parse(text) as Partial<SkillWithMetadata>;
              logger.debug(`[Metadata] Success from ${url} (${duration}ms)`);
              return json;
            } catch (e) {
              logger.debug(`[Metadata] JSON Parse Error from ${url}: ${e}`);
            }
          } else {
            logger.warn(`[Metadata] Failed ${url}: ${response.status}`);
          }
        } catch (err: any) {
          logger.debug(`[Metadata] Error fetching ${url}: ${err.message}`);
        }
      }

      logger.error(`[Metadata] All gateways failed for ${hash}`);
      return null;

    } catch (error) {
      logger.error(`[Metadata] Unexpected error processing ${metadataURI}: ${error}`);
      return null;
    }
  }
}

export const blockchainSkillClient = new BlockchainSkillClient();
