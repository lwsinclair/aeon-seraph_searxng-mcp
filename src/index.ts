import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

interface CacheEntry {
  data: SearchResult;
  timestamp: number;
}

// Simple cache to store recent searches
const searchCache: Record<string, CacheEntry> = {};
const CACHE_TTL = process.env.CACHE_TTL
  ? parseInt(process.env.CACHE_TTL)
  : 10 * 60 * 1000;
const MAX_CACHE_SIZE = process.env.MAX_CACHE_SIZE
  ? parseInt(process.env.MAX_CACHE_SIZE)
  : 100;

const SearchSchema = z.object({
  query: z
    .string()
    .describe("The search query string passed to external search services"),
  categories: z
    .string()
    .optional()
    .describe("Comma separated list of active search categories"),
  pageno: z.coerce
    .number()
    .int()
    .positive()
    .default(1)
    .describe("Search page number"),
  time_range: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Time range for search results"),
  raw_json: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, returns the raw JSON response instead of formatted text",
    ),
});

type SearchArgs = z.infer<typeof SearchSchema>;

interface SearchResult {
  query: string;
  number_of_results: number;
  results: Array<{
    title: string;
    url: string;
    content: string;
    engine: string;
    score?: number;
    category?: string;
    pretty_url?: string;
    publishedDate?: string;
  }>;
  suggestions: string[];
  answers: string[];
  corrections: string[];
  infoboxes: any[];
  engines: Record<string, any>;
  timing: Record<string, number>;
  version: string;
}

async function search(searchArgs: SearchArgs) {
  const { query, categories, pageno, time_range, raw_json } =
    searchArgs;

  // Cache key based on search params
  const cacheKey = JSON.stringify({
    query,
    categories,
    pageno,
    time_range,
  });

  // Check if search is already cached
  const now = Date.now();
  const cachedEntry = searchCache[cacheKey];

  if (cachedEntry && now - cachedEntry.timestamp < CACHE_TTL) {
    console.error(`Cache hit for query: ${query}`);

    const responseText = raw_json
      ? JSON.stringify(cachedEntry.data, null, 2)
      : formatResultsForLLM(cachedEntry.data);

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }

  // console.error(`Cache miss for query: ${query}`);

  const searxngHost = process.env.SEARXNG_HOST || "localhost";
  const searxngPort = process.env.SEARXNG_PORT || "8888";
  const searxngProtocol = process.env.SEARXNG_PROTOCOL || "http";
  const searxngBaseUrl = `${searxngProtocol}://${searxngHost}:${searxngPort}`;

  const url = new URL("/search", searxngBaseUrl);

  url.searchParams.append("q", query);
  url.searchParams.append("format", "json");

  if (categories) url.searchParams.append("categories", categories);
  if (pageno) url.searchParams.append("pageno", pageno.toString());
  if (time_range) url.searchParams.append("time_range", time_range);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Search failed with status: ${response.status}`);
    }

    const data: SearchResult = await response.json();

    // Store in cache
    searchCache[cacheKey] = {
      data,
      timestamp: now,
    };

    // Manage cache size by removing oldest entries if needed
    const cacheKeys = Object.keys(searchCache);
    if (cacheKeys.length > MAX_CACHE_SIZE) {
      const oldestKeys = cacheKeys
        .map((key) => ({ key, timestamp: searchCache[key].timestamp }))
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, cacheKeys.length - MAX_CACHE_SIZE)
        .map((entry) => entry.key);

      oldestKeys.forEach((key) => delete searchCache[key]);
    }

    const responseText = raw_json
      ? JSON.stringify(data, null, 2)
      : formatResultsForLLM(data);

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error searching SearXNG: ${error}`,
        },
      ],
    };
  }
}

function formatResultsForLLM(data: SearchResult): string {
  const { results, suggestions, answers, corrections, infoboxes } = data;

  let formattedText = `Search Results for: "${data.query}" (${data.number_of_results} results found)\n\n`;

  if (answers && answers.length > 0) {
    formattedText += "Direct Answers:\n";
    answers.forEach((answer, index) => {
      formattedText += `${index + 1}. ${answer}\n`;
    });
    formattedText += "\n";
  }

  if (infoboxes && infoboxes.length > 0) {
    formattedText += "Information Boxes:\n";
    infoboxes.forEach((infobox, index) => {
      formattedText += `Infobox ${index + 1}: ${JSON.stringify(infobox)}\n`;
    });
    formattedText += "\n";
  }

  if (corrections && corrections.length > 0) {
    formattedText += "Did you mean:\n";
    corrections.forEach((correction, index) => {
      formattedText += `${index + 1}. ${correction}\n`;
    });
    formattedText += "\n";
  }

  if (suggestions && suggestions.length > 0) {
    formattedText += "Search Suggestions:\n";
    suggestions.forEach((suggestion, index) => {
      formattedText += `${index + 1}. ${suggestion}\n`;
    });
    formattedText += "\n";
  }

  // Format main results
  if (results && results.length > 0) {
    formattedText += "Web Results:\n";

    results.forEach((result, index) => {
      const publishedDate = result.publishedDate
        ? ` (${result.publishedDate})`
        : "";
      formattedText += `${index + 1}. ${result.title}${publishedDate}\n`;
      formattedText += `   URL: ${result.url}\n`;
      formattedText += `   Engine: ${result.engine}\n`;
      formattedText += `   Summary: ${result.content.trim()}\n\n`;
    });
  }

  return formattedText;
}

const server = new Server(
  {
    name: "searxng-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search the internet using a variety of search engines.",
        inputSchema: zodToJsonSchema(SearchSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!request.params.arguments) {
      throw new Error("Arguments are required");
    }

    if (request.params.name === "search") {
      const args = SearchSchema.parse(request.params.arguments);
      const result = await search(args);
      return result;
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    console.error("Error in CallToolRequestSchema handler:", error);

    if (error instanceof z.ZodError) {
      throw new Error(`Invalid input: ${JSON.stringify(error.errors)}`);
    }

    throw error;
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SearXNG MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error in runServer():", error);
  process.exit(1);
});
