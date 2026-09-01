import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateArticleInput, GetArticleInput, NoosphereResponse, RecallMemoryInput, SaveMemoryInput, SearchArticlesInput } from "./client.js";
export interface NoosphereApi {
    searchArticles(input: SearchArticlesInput): Promise<NoosphereResponse>;
    getArticle(input: GetArticleInput): Promise<NoosphereResponse>;
    saveMemory(input: SaveMemoryInput): Promise<NoosphereResponse>;
    recallMemory(input: RecallMemoryInput): Promise<NoosphereResponse>;
    createArticle(input: CreateArticleInput): Promise<NoosphereResponse>;
}
export declare function createNoosphereMcpServer(api: NoosphereApi, version: string): McpServer;
//# sourceMappingURL=server.d.ts.map